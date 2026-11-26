/**
 * Agent 循环：调模型 → 执行工具 → 回填结果 → 下一轮。每一轮都写事件。
 *
 * 关键取舍：
 *   1. 工具失败不抛异常。Agent 的常态就是「工具会失败」，抛异常会让一次小失败毁掉整轮任务。
 *      失败按类型回给模型（见 ERROR_POLICY），internal 才是致命的。
 *   2. 每轮结束立刻写事件，而不是跑完再写。这样进程被杀，已完成的工作不丢。
 *   3. thinking 块默认丢弃（stripThinking），因为它是草稿纸，留在历史里会逐轮放大上下文。
 */
import { ERROR_POLICY } from './types.mjs';

/**
 * @param {object} o
 * @param {object} o.llm
 * @param {import('./tools.mjs').ToolRegistry} o.tools
 * @param {string} o.system
 * @param {string} [o.goal] 初始用户消息（不给则用 messages）
 * @param {object[]} [o.messages]
 * @param {import('./eventlog.mjs').EventLog} o.log
 * @param {number} [o.maxTurns=8]
 * @param {string[]} [o.allow] 允许调用的工具白名单
 * @param {string[]} [o.deny] 禁止调用的工具
 * @param {boolean} [o.stripThinking=true]
 * @param {AbortSignal} [o.signal]
 * @param {(e:object)=>void} [o.onTurn]
 */
export async function runLoop(o) {
    const {
        llm,
        tools,
        system,
        goal,
        log,
        maxTurns = 8,
        allow,
        deny,
        stripThinking = true,
        signal,
        onTurn = () => {},
    } = o;
    let messages = o.messages ? [...o.messages] : [{ role: 'user', content: goal || '' }];
    const specs = tools.specs({ allow, deny });
    const usage = { inputTokens: 0, outputTokens: 0, costUsd: 0 };
    let turns = 0;

    for (let turn = 1; turn <= maxTurns; turn++) {
        if (signal?.aborted) return { messages, turns, usage, stopReason: 'aborted', answer: '' };
        turns = turn;

        const res = await llm.chat({ system, messages, tools: specs, signal });
        usage.inputTokens += res.usage.inputTokens;
        usage.outputTokens += res.usage.outputTokens;
        usage.costUsd += res.usage.costUsd || 0;

        const text = res.content.filter((b) => b.type === 'text').map((b) => b.text).join('\n');
        log.append('llm_response', {
            turn,
            text,
            toolCalls: res.toolCalls,
            usage: { inputTokens: res.usage.inputTokens, outputTokens: res.usage.outputTokens, costUsd: res.usage.costUsd || 0, cacheReadTokens: res.usage.cacheReadTokens || 0 },
            degraded: res.degraded || [],
        });

        const kept = stripThinking ? res.content.filter((b) => b.type !== 'thinking' && b.type !== 'redacted_thinking') : res.content;
        if (kept.length) messages.push({ role: 'assistant', content: kept });
        else messages.push({ role: 'assistant', content: [{ type: 'text', text: text || '（无输出）' }] });

        onTurn({ turn, text, toolCalls: res.toolCalls, usage: res.usage });

        if (!res.toolCalls.length || res.stopReason === 'end') {
            log.append('loop_finished', { turns: turn, stopReason: 'answer', usage });
            return { messages, turns, usage, stopReason: 'answer', answer: text };
        }

        const resultBlocks = [];
        for (const call of res.toolCalls) {
            const r = await tools.execute(call, { signal, allow, deny });
            log.append('tool_result', { turn, result: r });

            const policy = ERROR_POLICY[r.error?.kind] || ERROR_POLICY.internal;
            if (!r.ok && policy.fatal) {
                log.append('loop_finished', { turns: turn, stopReason: 'fatal_tool_error', usage });
                throw Object.assign(new Error(`工具 ${r.name} 内部错误：${r.error?.message}`), { kind: 'internal', result: r });
            }
            resultBlocks.push({
                type: 'tool_result',
                tool_use_id: call.id,
                content: r.ok ? stringify(r.output) : `[${r.error.kind}] ${r.error.message}`,
                is_error: !r.ok,
            });
        }
        messages.push({ role: 'user', content: resultBlocks });
    }

    log.append('loop_finished', { turns, stopReason: 'max_turns', usage });
    return { messages, turns, usage, stopReason: 'max_turns', answer: '' };
}

function stringify(v) {
    if (v == null) return '';
    if (typeof v === 'string') return v;
    return JSON.stringify(v);
}
