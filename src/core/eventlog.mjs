/**
 * 事件日志：唯一事实源。
 *
 * 设计取舍（和「存一张状态表」对比）：
 *   存状态  → 恢复需要额外的快照机制，且每次状态变化都要想「哪些字段要存」
 *   存事件  → 只追加，状态是算出来的；回放、审计、评测归因免费得到
 *
 * 代价是查询慢，所以另有一层 SQLite 索引（见 src/core/db.mjs），但**事实源永远是 JSONL**。
 * 这一条是硬约束：数据库可以被删掉重建，事件日志不能。
 */
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

export class EventLog {
    /**
     * @param {string} dir 存放目录；每个 run 一个子目录
     * @param {string} [runId]
     */
    constructor(dir, runId) {
        this.dir = dir;
        this.runId = runId || randomUUID().slice(0, 8);
        this.file = path.join(dir, this.runId, 'events.jsonl');
        fs.mkdirSync(path.dirname(this.file), { recursive: true });
        this.seq = 0;
    }

    /** 追加一条事件。事件不可修改、不可删除。 */
    append(type, data = {}) {
        const ev = { seq: ++this.seq, type, runId: this.runId, at: new Date().toISOString(), ...data };
        fs.appendFileSync(this.file, JSON.stringify(ev) + '\n');
        return ev;
    }

    static read(dir, runId) {
        const file = path.join(dir, runId, 'events.jsonl');
        if (!fs.existsSync(file)) return [];
        return fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
    }

    static list(dir) {
        if (!fs.existsSync(dir)) return [];
        return fs.readdirSync(dir)
            .filter((d) => fs.existsSync(path.join(dir, d, 'events.jsonl')))
            .map((d) => {
                const evs = EventLog.read(dir, d);
                const start = evs.find((e) => e.type === 'run_started');
                const end = evs.findLast ? evs.findLast((e) => e.type === 'run_finished') : [...evs].reverse().find((e) => e.type === 'run_finished');
                return {
                    runId: d,
                    task: start?.task ?? '',
                    mode: start?.mode ?? '',
                    status: end?.status ?? 'running',
                    startedAt: start?.at ?? '',
                    finishedAt: end?.at ?? '',
                    events: evs.length,
                };
            })
            .sort((a, b) => String(b.startedAt).localeCompare(String(a.startedAt)));
    }
}

/**
 * 从事件折叠出状态。
 *
 * 折叠是纯函数：同样的输入永远得到同样的输出。这是「回放」能成立的前提。
 *
 * @param {object[]} events
 */
export function fold(events) {
    const st = {
        runId: null,
        task: '',
        mode: '',
        status: 'unknown',
        node: null,
        turns: 0,
        messages: [],
        usage: { inputTokens: 0, outputTokens: 0, costUsd: 0 },
        pendingInterrupt: null,
        children: [],
        toolCalls: [],
        stopReason: null,
    };

    for (const e of events) {
        switch (e.type) {
            case 'run_started':
                st.runId = e.runId;
                st.task = e.task;
                st.mode = e.mode;
                st.status = 'running';
                break;
            case 'node_enter':
                st.node = e.node;
                break;
            case 'node_exit':
                if (st.node === e.node) st.node = null;
                break;
            case 'llm_response':
                st.turns++;
                st.messages.push({ role: 'assistant', content: e.text || '', toolCalls: e.toolCalls });
                st.usage.inputTokens += e.usage?.inputTokens || 0;
                st.usage.outputTokens += e.usage?.outputTokens || 0;
                st.usage.costUsd += e.usage?.costUsd || 0;
                break;
            case 'tool_result':
                st.toolCalls.push(e.result);
                break;
            case 'interrupt':
                st.pendingInterrupt = { node: e.node, question: e.question, options: e.options || [] };
                break;
            case 'resume':
                st.pendingInterrupt = null;
                break;
            case 'child_started':
                st.children.push({ runId: e.childRunId, agent: e.agent, task: e.task, status: 'running' });
                break;
            case 'child_finished': {
                const c = st.children.find((x) => x.runId === e.childRunId);
                if (c) {
                    c.status = e.status;
                    c.answer = e.answer;
                }
                break;
            }
            case 'run_finished':
                st.status = e.status;
                st.stopReason = e.stopReason || null;
                if (e.answer) st.answer = e.answer;
                break;
            default:
                break;
        }
    }
    return st;
}

/**
 * 不变量校验：事件流自身必须自洽，否则说明写日志的代码有 bug。
 * 在评测与回放前调用，避免「用坏数据得出好结论」。
 */
export function validate(events) {
    const errs = [];
    const starts = events.filter((e) => e.type === 'run_started');
    const ends = events.filter((e) => e.type === 'run_finished');
    if (starts.length !== 1) errs.push(`run_started 应恰好 1 条，实际 ${starts.length}`);
    if (ends.length > 1) errs.push(`run_finished 最多 1 条，实际 ${ends.length}`);

    const issued = new Set();
    const consumed = new Set();
    for (const e of events) {
        if (e.type === 'llm_response') for (const c of e.toolCalls || []) issued.add(c.id);
        if (e.type === 'tool_result') {
            const id = e.result?.toolCallId;
            if (!issued.has(id)) errs.push(`seq=${e.seq} tool_result 的 toolCallId=${id} 没有对应的 llm_response`);
            if (consumed.has(id)) errs.push(`seq=${e.seq} toolCallId=${id} 被重复回填`);
            consumed.add(id);
        }
        if (e.type === 'resume') {
            const prev = events.filter((x) => x.seq < e.seq && x.type === 'interrupt');
            const prevResumes = events.filter((x) => x.seq < e.seq && x.type === 'resume');
            if (prev.length <= prevResumes.length) errs.push(`seq=${e.seq} resume 没有对应的 interrupt`);
        }
    }
    if (events.length && events[0].type !== 'run_started') errs.push(`第一条事件应为 run_started，实际 ${events[0].type}`);
    return errs;
}
