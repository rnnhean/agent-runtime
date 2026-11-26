/**
 * Agent 门面：把「技能加载 → 工具集 → 循环」串起来，并支持委派子 Agent。
 *
 * 多 Agent 的正确用法（这是本模块的核心主张）：
 *   不是让几个 Agent 互相聊天，而是**父 Agent 把子 Agent 当成一个工具调用**。
 *   理由：
 *     - 子 Agent 的完整过程不需要污染父上下文，只回一个结论
 *     - 失败可以按工具错误处理（重试 / 换策略），而不是让整条链路崩掉
 *     - 父子关系可追踪（事件里记 child_started / child_finished）
 *
 * 这是 JD 里 multi-agent 只有 7% 的原因：多数场景单 Agent + 多工具就够，
 * 真正需要子 Agent 的是「子任务上下文很长，但结论很短」这种。
 */
import { EventLog, fold } from '../core/eventlog.mjs';
import { runLoop } from '../core/loop.mjs';
import { ToolRegistry, defineTool } from '../core/tools.mjs';
import { loadSkills, selectSkills, renderSkills, skillsToolAllow } from '../skills/loader.mjs';
import { createTrace, TraceRecorder } from '../observability/trace.mjs';

/**
 * @param {object} o
 * @param {object} o.llm
 * @param {string[]} [o.toolNames] 从注册表挑选要用的工具；不给则用全部
 * @param {string} [o.skillsDir]
 * @param {string} o.eventDir
 * @param {string} o.system
 * @param {number} [o.maxTurns=8]
 * @param {string[]} [o.deny]
 */
export function createAgent(o) {
    return {
        /** 单次运行（无状态机，纯循环） */
        async run(task, { mode = 'offline', runId } = {}) {
            const log = runId ? new EventLog(o.eventDir, runId) : new EventLog(o.eventDir);
            // 若调用方已经建过并写了 run_started（例如异步接口先返回 runId），不重复写
            const existing = EventLog.read(o.eventDir, log.runId);
            if (!existing.some((e) => e.type === 'run_started')) {
                log.append('run_started', { task, mode, agent: 'root' });
            }

            const skills = o.skillsDir ? selectSkills(loadSkills(o.skillsDir), task) : [];
            const skillText = renderSkills(skills);
            log.append('skills_selected', { skills: skills.map((s) => s.name) });

            const registry = new ToolRegistry();
            (o.tools || []).forEach((t) => registry.register(t));
            const allow = o.toolNames || (skills.length ? merge(skillsToolAllow(skills), o.alwaysAllow) : undefined);

            const system = [o.system, skillText].filter(Boolean).join('\n\n');

            const loop = await runLoop({
                llm: o.llm,
                tools: registry,
                system,
                goal: task,
                log,
                maxTurns: o.maxTurns || 8,
                allow,
                deny: o.deny,
            });

            log.append('run_finished', { status: loop.stopReason === 'answer' ? 'ok' : 'failed', answer: loop.answer, stopReason: loop.stopReason });
            return { runId: log.runId, ...loop, skills: skills.map((s) => s.name) };
        },

        /** 把「另一个 Agent」包装成一个工具，供父 Agent 调用 */
        asTool({ name, description, subLlm, subTools, subSystem, maxTurns = 6, eventDir, skillDir }) {
            return defineTool({
                name,
                description,
                parameters: {
                    type: 'object',
                    properties: { task: { type: 'string', description: '交给子 Agent 的完整任务描述' } },
                    required: ['task'],
                },
                timeoutMs: 120_000,
                parse: (args) => {
                    const t = String(args?.task ?? '').trim();
                    if (!t) return { ok: false, error: 'task 必填' };
                    return { ok: true, value: { task: t } };
                },
                run: async ({ task }) => {
                    const subAgent = createAgent({
                        llm: subLlm,
                        tools: subTools,
                        eventDir,
                        system: subSystem,
                        maxTurns,
                        skillsDir: skillDir,
                    });
                    const r = await subAgent.run(task, { mode: subLlm.mode || 'offline' });
                    // 只把结论和 runId 回给父 Agent，不把子 Agent 的全部中间过程塞回父上下文——
                    // 这正是「委派」相对「多轮对话」的价值
                    return { childRunId: r.runId, answer: r.answer, turns: r.turns, stopReason: r.stopReason };
                },
            });
        },
    };
}

function merge(a, b) {
    const s = new Set([...(a || []), ...(b || [])]);
    return [...s];
}

export { fold, TraceRecorder, createTrace };
