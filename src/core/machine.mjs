/**
 * 状态机：节点 + 跳转 + 中断 + 恢复。
 *
 * 这是整个 harness 里最难的部分，也是面试最常问的部分。核心问题只有一个：
 * **一个跑十几分钟、中途需要人拍板的任务，进程死了怎么接着跑，且不重复已完成的工作。**
 *
 * 三个设计决定：
 *   1. 状态不存内存，全部从事件折叠。恢复 = 重放事件找到断点。
 *   2. Interrupt 是抛异常实现的：节点里调 `throw new Interrupt(...)`，调度器捕获后写事件并返回。
 *   3. 节点重入时必须幂等——恢复会重新进入中断的那个节点，所以节点要用 ctx.state 判断
 *      「这一步是否已经做过」，而不是盲目再执行一次副作用。
 */
import { EventLog, fold } from './eventlog.mjs';

export class Interrupt extends Error {
    /**
     * @param {string} question 给人类的问题
     * @param {object} [o]
     * @param {string[]} [o.options]
     * @param {object} [o.context] 人类做决定需要的上下文（会写进事件，所以不要放凭据）
     */
    constructor(question, { options = [], context = {} } = {}) {
        super(question);
        this.name = 'Interrupt';
        this.question = question;
        this.options = options;
        this.context = context;
    }
}

/**
 * @typedef {object} WorkflowContext
 * @property {object} state 节点间共享的状态（会被持久化进事件，恢复时还原）
 * @property {string} task 原始任务
 * @property {object} services 注入的服务（llm、tools、log 等）
 * @property {string} [humanAnswer] 恢复时人类给的答案
 * @property {EventLog} log
 */

/**
 * @param {object} o
 * @param {string} o.name
 * @param {Object<string, (ctx: WorkflowContext) => Promise<{goto?: string, done?: boolean, output?: string, state?: object}>>} o.nodes
 * @param {string} o.entry
 * @param {number} [o.maxTransitions=20] 防止节点互相跳转成死循环
 */
export function defineWorkflow({ name, nodes, entry, maxTransitions = 20 }) {
    if (!nodes[entry]) throw new Error(`入口节点 ${entry} 不存在`);
    return { name, nodes, entry, maxTransitions };
}

/**
 * 执行（或恢复）一次工作流。
 *
 * @param {object} o
 * @param {object} o.workflow defineWorkflow 的产物
 * @param {string} o.eventDir
 * @param {string} [o.runId] 传了就恢复该 run，不传则新建
 * @param {string} [o.task]
 * @param {object} [o.services]
 * @param {string} [o.humanAnswer] 恢复时人类答案
 * @param {string} [o.mode='offline']
 */
export async function runWorkflow(o) {
    const { workflow, eventDir, services = {}, humanAnswer, mode = 'offline' } = o;

    // 恢复：从事件折叠出状态，找到中断点
    let log;
    let state = {};
    let task = o.task || '';
    let startNode = workflow.entry;
    let pendingAnswer = humanAnswer;

    if (o.runId) {
        const events = EventLog.read(eventDir, o.runId);
        const st = fold(events);
        log = Object.create(EventLog.prototype);
        Object.assign(log, { dir: eventDir, runId: o.runId, file: `${eventDir}/${o.runId}/events.jsonl`, seq: events.length ? events[events.length - 1].seq : 0 });
        task = st.task;
        state = reconstructState(events);

        // 从最后一个未消费的 interrupt 恢复
        const interrupts = events.filter((e) => e.type === 'interrupt');
        const resumes = events.filter((e) => e.type === 'resume');
        if (interrupts.length > resumes.length) {
            startNode = interrupts[interrupts.length - 1].node;
            log.append('resume', { node: startNode, answer: pendingAnswer ?? '' });
        } else {
            // 没有待处理的中断：已完成或已失败。不重复执行。
            return { runId: o.runId, status: st.status, answer: st.answer || '', resumedFrom: null, events };
        }
    } else {
        log = new EventLog(eventDir);
        log.append('run_started', { task, mode, workflow: workflow.name });
    }

    const ctx = {
        task,
        state,
        services,
        log,
        humanAnswer: pendingAnswer,
        nodeResults: [],
    };

    let current = startNode;
    let transitions = 0;
    const visited = [];

    while (current && transitions++ < workflow.maxTransitions) {
        const fn = workflow.nodes[current];
        if (!fn) {
            log.append('run_finished', { status: 'failed', error: `节点 ${current} 不存在` });
            return { runId: log.runId, status: 'failed', error: `节点 ${current} 不存在` };
        }

        visited.push(current);
        log.append('node_enter', { node: current });

        try {
            // 恢复进入的节点能拿到 humanAnswer；其他节点拿到 undefined
            const r = await fn(ctx);
            ctx.humanAnswer = undefined; // 只给中断点后的第一次进入用
            if (r?.state) Object.assign(state, r.state);
            // 状态快照必须落进事件，否则恢复时无从重建——这是恢复能力的根
            log.append('node_exit', { node: current, outcome: r?.done ? 'done' : (r?.goto || 'end'), state: { ...state } });
            if (r?.done) {
                log.append('run_finished', { status: 'ok', answer: r.output || '', stopReason: 'workflow_done' });
                return { runId: log.runId, status: 'ok', answer: r.output || '', visited };
            }
            current = r?.goto;
        } catch (e) {
            if (e instanceof Interrupt) {
                log.append('interrupt', { node: current, question: e.question, options: e.options, context: e.context });
                log.append('run_finished', { status: 'interrupted', answer: '', stopReason: 'interrupt' });
                return { runId: log.runId, status: 'interrupted', question: e.question, options: e.options, node: current, visited };
            }
            log.append('run_finished', { status: 'failed', error: String(e?.message || e), stopReason: 'exception' });
            throw e;
        }
    }

    log.append('run_finished', { status: 'failed', error: '超过最大跳转次数', stopReason: 'max_transitions' });
    return { runId: log.runId, status: 'failed', error: '超过最大跳转次数', visited };
}

/**
 * 从事件重建节点间共享状态。
 *
 * 约定：节点把自己的产出挂在 ctx.state 上，写事件时放在 node_exit.state 里。
 * 这里把所有的 state 快照按顺序合并，得到恢复时的状态。
 */
function reconstructState(events) {
    const s = {};
    for (const e of events) {
        if (e.type === 'node_exit' && e.state && typeof e.state === 'object') Object.assign(s, e.state);
        // 兼容：有些节点直接把关键结果写在 node_exit 的其它字段里
        if (e.type === 'node_exit' && e.result) s[nodeExitKey(e)] = e.result;
    }
    return s;
}

function nodeExitKey(e) {
    return `${e.node}:result`;
}
