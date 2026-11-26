/**
 * 工具注册表。
 *
 * 设计要点：
 *   1. 参数校验与执行分离（parse 先跑，执行前就知道参数对不对）——这样参数错能回给模型，
 *      而工具内部的业务错误也能分清，两类错误处理方式不同。
 *   2. 每个工具单独超时与重试策略，而不是全局一刀切：查缓存 100ms 和调外部 API 30s 不该同待遇。
 *   3. 权限白名单在注册表层做，不在提示词里做。模型说「我要调 delete_all」时，是代码拦，不是靠它自觉。
 */
import { classifyError } from './types.mjs';

/**
 * @param {object} spec
 * @param {string} spec.name
 * @param {string} spec.description 给模型看：写清「什么时候用、什么时候别用」
 * @param {object} spec.parameters JSON Schema
 * @param {(args: unknown, ctx: object) => Promise<unknown>} spec.run
 * @param {(args: unknown) => {ok: boolean, value?: unknown, error?: string}} [spec.parse]
 * @param {number} [spec.timeoutMs=30000]
 * @param {number} [spec.retries=0]
 * @param {string[]} [spec.tags] 用于按场景筛选工具集
 */
export function defineTool(spec) {
    if (!spec?.name || !spec?.description || !spec?.parameters) {
        throw new Error('工具必须提供 name / description / parameters');
    }
    return {
        timeoutMs: 30_000,
        retries: 0,
        tags: [],
        ...spec,
    };
}

export class ToolRegistry {
    constructor() {
        /** @type {Map<string, ReturnType<typeof defineTool>>} */
        this.tools = new Map();
    }

    register(tool) {
        if (this.tools.has(tool.name)) throw new Error(`工具重名：${tool.name}`);
        // 允许直接 register 裸对象（不调 defineTool）：缺省值在这里补齐，
        // 否则 timeoutMs 为 undefined 会让 setTimeout 立刻触发，工具全部误判超时
        this.tools.set(tool.name, {
            timeoutMs: 30_000,
            retries: 0,
            tags: [],
            ...tool,
        });
        return this;
    }

    has(name) {
        return this.tools.has(name);
    }

    /** 给模型看的工具定义 */
    specs({ allow, deny } = {}) {
        const list = [...this.tools.values()].filter((t) => {
            if (deny?.includes(t.name)) return false;
            if (allow && !allow.includes(t.name)) return false;
            return true;
        });
        return list.map((t) => ({ name: t.name, description: t.description, input_schema: t.parameters }));
    }

    /**
     * 执行一次工具调用。永不抛异常——所有失败都变成结构化的 ToolResult，
     * 因为「工具失败」是 Agent 的常见正常路径，不该炸掉整个循环。
     *
     * @param {import('./types.mjs').ToolCall} call
     * @param {{signal?: AbortSignal, logger?: object, allow?: string[], deny?: string[]}} ctx
     * @returns {Promise<import('./types.mjs').ToolResult>}
     */
    async execute(call, ctx = {}) {
        const started = Date.now();
        const base = { toolCallId: call.id, name: call.name };

        // 权限：白名单优先于一切
        if (ctx.deny?.includes(call.name)) {
            return { ...base, ok: false, durationMs: 0, error: { kind: 'permission', message: `工具 ${call.name} 被禁止调用` } };
        }
        if (ctx.allow && !ctx.allow.includes(call.name)) {
            return { ...base, ok: false, durationMs: 0, error: { kind: 'permission', message: `工具 ${call.name} 不在允许列表内` } };
        }

        const tool = this.tools.get(call.name);
        if (!tool) {
            return { ...base, ok: false, durationMs: 0, error: { kind: 'validation', message: `未知工具 ${call.name}` } };
        }

        // 参数校验
        if (tool.parse) {
            try {
                const p = tool.parse(call.args);
                if (!p.ok) {
                    return { ...base, ok: false, durationMs: 0, error: { kind: 'validation', message: p.error || '参数不合法' } };
                }
                call = { ...call, args: p.value };
            } catch (e) {
                return { ...base, ok: false, durationMs: 0, error: { kind: 'validation', message: String(e.message || e) } };
            }
        }

        let lastErr;
        for (let attempt = 0; attempt <= tool.retries; attempt++) {
            try {
                const output = await withTimeout(
                    Promise.resolve(tool.run(call.args, ctx)),
                    tool.timeoutMs,
                    ctx.signal,
                );
                return { ...base, ok: true, output, durationMs: Date.now() - started };
            } catch (e) {
                lastErr = e;
                const kind = classifyError(e);
                // 只有网络/超时才值得重试；参数错、权限错、内部 bug 重试只是放大问题
                if (!['network', 'timeout'].includes(kind) || attempt === tool.retries) break;
            }
        }
        const kind = classifyError(lastErr);
        return {
            ...base,
            ok: false,
            durationMs: Date.now() - started,
            error: { kind, message: String(lastErr?.message || lastErr) },
        };
    }
}

function withTimeout(p, ms, signal) {
    return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(Object.assign(new Error(`timeout after ${ms}ms`), { kind: 'timeout' })), ms);
        const onAbort = () => reject(Object.assign(new Error('aborted'), { kind: 'timeout' }));
        signal?.addEventListener('abort', onAbort, { once: true });
        p.then(
            (v) => {
                clearTimeout(timer);
                signal?.removeEventListener('abort', onAbort);
                resolve(v);
            },
            (e) => {
                clearTimeout(timer);
                signal?.removeEventListener('abort', onAbort);
                reject(e);
            },
        );
    });
}
