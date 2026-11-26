/**
 * LLM 适配层：一个内部消息格式，多个 provider 各做双向转换。
 *
 * 为什么自写薄适配层而不直接用厂商 SDK：
 *   SDK 会把「消息格式」绑死在厂商身上，一旦要接第二家就得在业务代码里做分支。
 *   这里把差异收在 adapter 内，loop / harness / eval 只认一套 Message。
 *
 * 支持三种：ScriptedClient（离线确定性）、OpenAI 兼容、Anthropic 原生。
 */

/** 内部消息：content 是字符串或块数组（与 Anthropic 形状对齐，减少一层转换） */
export const msg = {
    user: (content) => ({ role: 'user', content }),
    assistant: (content) => ({ role: 'assistant', content }),
};

// ---------------------------------------------------------------- 离线确定性客户端

/**
 * 完全离线、确定性、不发网络请求。用于 CI、评测基线、演示。
 *
 * 它模拟的是一个「按脚本行动」的模型：给一个 plan（每步返回什么），依次吐出。
 * 任何用它的结论都必须标注「离线脚本模式，不代表模型能力」。
 */
export class ScriptedClient {
    constructor(plan) {
        this.plan = plan;
        this.i = 0;
        this.name = 'scripted';
        this.mode = 'offline';
    }

    async chat({ messages, tools = [] }) {
        const step = this.plan[Math.min(this.i++, this.plan.length - 1)];
        const content = typeof step === 'function' ? await step({ messages, tools, index: this.i - 1 }) : step;
        return {
            content,
            toolCalls: content.filter((b) => b.type === 'tool_use').map((b) => ({ id: b.id, name: b.name, args: b.input })),
            stopReason: content.some((b) => b.type === 'tool_use') ? 'tool_use' : 'end',
            usage: { inputTokens: 0, outputTokens: 0, costUsd: 0, estimated: true },
            degraded: [],
        };
    }
}

// ---------------------------------------------------------------- Anthropic 原生

/**
 * @param {object} o
 * @param {string} o.model
 * @param {string} [o.baseUrl]
 * @param {string} [o.keyEnv='LLM_API_KEY']
 * @param {number} [o.maxTokens=2048]
 * @param {(n:number)=>number} [o.price] 每百万 token 单价，用于算成本
 */
export function anthropicClient({ model, baseUrl = process.env.LLM_BASE_URL || 'https://api.anthropic.com', keyEnv = 'LLM_API_KEY', maxTokens = 2048, price } = {}) {
    const base = String(baseUrl).replace(/\/+$/, '');
    const endpoint = base.endsWith('/v1') ? `${base}/messages` : `${base}/v1/messages`;
    return {
        name: `anthropic:${model}`,
        mode: 'live',
        async chat({ system, messages, tools, toolChoice, signal }) {
            const key = process.env[keyEnv];
            if (!key) throw new Error(`未设置 ${keyEnv}`);
            const body = {
                model,
                max_tokens: maxTokens,
                temperature: 0,
                messages: toAnthropicMessages(messages),
                ...(system ? { system } : {}),
                ...(tools?.length ? { tools: tools.map((t) => ({ name: t.name, description: t.description, input_schema: t.input_schema || t.parameters })) } : {}),
                ...(toolChoice && tools?.length ? { tool_choice: toolChoice } : {}),
            };
            const res = await fetch(endpoint, {
                method: 'POST',
                headers: { 'content-type': 'application/json', 'x-api-key': key, 'anthropic-version': '2023-06-01' },
                body: JSON.stringify(body),
                signal,
            });
            if (!res.ok) throw Object.assign(new Error(`HTTP ${res.status}`), { kind: res.status === 429 || res.status >= 500 ? 'network' : 'internal' });
            const j = await res.json();
            const content = j.content || [];
            const u = j.usage || {};
            const inTok = u.input_tokens || 0;
            const outTok = u.output_tokens || 0;
            return {
                content,
                toolCalls: content.filter((b) => b.type === 'tool_use').map((b) => ({ id: b.id, name: b.name, args: b.input })),
                stopReason: j.stop_reason === 'tool_use' ? 'tool_use' : 'end',
                usage: {
                    inputTokens: inTok,
                    outputTokens: outTok,
                    costUsd: price ? price(inTok, outTok) : 0,
                    cacheReadTokens: u.cache_read_input_tokens || 0,
                },
                degraded: [],
            };
        },
    };
}

// ---------------------------------------------------------------- OpenAI 兼容

/**
 * 很多国内网关、自建代理都走 OpenAI 的 /chat/completions。
 * 主要差异：消息里 tool_calls 是 assistant 的属性，工具结果用 role:'tool' 单独一条。
 */
export function openaiCompatClient({ model, baseUrl = process.env.LLM_BASE_URL || 'https://api.openai.com/v1', keyEnv = 'LLM_API_KEY', maxTokens = 2048, price } = {}) {
    const base = String(baseUrl).replace(/\/+$/, '');
    const endpoint = base.endsWith('/v1') ? `${base}/chat/completions` : `${base}/v1/chat/completions`;
    return {
        name: `openai:${model}`,
        mode: 'live',
        async chat({ system, messages, tools, toolChoice, signal }) {
            const key = process.env[keyEnv];
            if (!key) throw new Error(`未设置 ${keyEnv}`);
            const body = {
                model,
                max_tokens: maxTokens,
                temperature: 0,
                messages: toOpenAIMessages(system, messages),
                ...(tools?.length
                    ? { tools: tools.map((t) => ({ type: 'function', function: { name: t.name, description: t.description, parameters: t.input_schema || t.parameters } })) }
                    : {}),
                ...(toolChoice && tools?.length ? { tool_choice: mapToolChoice(toolChoice) } : {}),
            };
            const res = await fetch(endpoint, {
                method: 'POST',
                headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
                body: JSON.stringify(body),
                signal,
            });
            if (!res.ok) throw Object.assign(new Error(`HTTP ${res.status}`), { kind: res.status === 429 || res.status >= 500 ? 'network' : 'internal' });
            const j = await res.json();
            const choice = j.choices?.[0];
            const m = choice?.message || {};
            const toolCalls = (m.tool_calls || []).map((tc) => ({
                id: tc.id,
                name: tc.function?.name,
                args: safeJson(tc.function?.arguments),
            }));
            const content = [];
            if (m.content) content.push({ type: 'text', text: m.content });
            for (const tc of m.tool_calls || []) {
                content.push({ type: 'tool_use', id: tc.id, name: tc.function?.name, input: safeJson(tc.function?.arguments) });
            }
            const u = j.usage || {};
            return {
                content,
                toolCalls,
                stopReason: toolCalls.length ? 'tool_use' : 'end',
                usage: {
                    inputTokens: u.prompt_tokens || 0,
                    outputTokens: u.completion_tokens || 0,
                    costUsd: price ? price(u.prompt_tokens || 0, u.completion_tokens || 0) : 0,
                },
                degraded: [],
            };
        },
    };
}

// ---------------------------------------------------------------- 转换

/** 内部 → Anthropic。内部形状已对齐，只需保证 tool_result 在 user 消息里且 id 正确。 */
export function toAnthropicMessages(messages) {
    return messages.map((m) => {
        if (typeof m.content === 'string') return { role: m.role, content: [{ type: 'text', text: m.content }] };
        return {
            role: m.role,
            content: m.content.map((b) => {
                if (b.type === 'tool_result') return { type: 'tool_result', tool_use_id: b.tool_use_id, content: String(b.content ?? '') };
                if (b.type === 'tool_use') return { type: 'tool_use', id: b.id, name: b.name, input: b.input };
                return { type: 'text', text: String(b.text ?? '') };
            }),
        };
    });
}

/** 内部 → OpenAI。工具结果拆成独立的 role:'tool' 消息，tool_use 合并进 assistant 的 tool_calls。 */
export function toOpenAIMessages(system, messages) {
    const out = [];
    if (system) out.push({ role: 'system', content: system });
    for (const m of messages) {
        if (typeof m.content === 'string') {
            out.push({ role: m.role, content: m.content });
            continue;
        }
        if (m.role === 'assistant') {
            const text = m.content.filter((b) => b.type === 'text').map((b) => b.text).join('\n');
            const calls = m.content.filter((b) => b.type === 'tool_use');
            out.push({
                role: 'assistant',
                content: text || null,
                ...(calls.length
                    ? {
                        tool_calls: calls.map((c) => ({
                            id: c.id,
                            type: 'function',
                            function: { name: c.name, arguments: JSON.stringify(c.input ?? {}) },
                        })),
                    }
                    : {}),
            });
            continue;
        }
        // user 消息里可能夹着 tool_result，必须拆成独立消息，否则 OpenAI 会报错
        const texts = m.content.filter((b) => b.type === 'text');
        const results = m.content.filter((b) => b.type === 'tool_result');
        if (texts.length) out.push({ role: 'user', content: texts.map((b) => b.text).join('\n') });
        for (const r of results) {
            out.push({ role: 'tool', tool_call_id: r.tool_use_id, content: String(r.content ?? '') });
        }
    }
    return out;
}

function mapToolChoice(tc) {
    if (tc.type === 'tool') return { type: 'function', function: { name: tc.name } };
    if (tc.type === 'any') return 'required';
    return 'auto';
}

function safeJson(s) {
    if (s == null) return {};
    if (typeof s === 'object') return s;
    try {
        return JSON.parse(s);
    } catch {
        return {};
    }
}
