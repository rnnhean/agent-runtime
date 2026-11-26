/**
 * 核心类型约定（JSDoc，运行时零开销）。
 *
 * 为什么用 JSDoc 而不是 TypeScript：本项目要在 Docker 里零构建直接跑，
 * 引入 tsc 会把镜像构建变成两步，且 CI 要配 tsconfig。JSDoc 在编辑器里同样有类型提示。
 *
 * 一个贯穿全项目的取舍：**事件是唯一事实源**。
 * 不保存「当前状态」，只追加「发生过什么」，状态由 fold(events) 算出来。
 * 好处是恢复、回放、评测归因、审计共用同一份数据；代价是查询变慢（用 SQLite 索引补偿）。
 */

/**
 * @typedef {'user'|'assistant'|'tool'} Role
 *
 * @typedef {object} ToolCall
 * @property {string} id
 * @property {string} name
 * @property {Record<string, unknown>} args
 *
 * @typedef {'validation'|'business'|'network'|'timeout'|'internal'|'permission'} ToolErrorKind
 *
 * @typedef {object} ToolResult
 * @property {string} toolCallId
 * @property {string} name
 * @property {boolean} ok
 * @property {unknown} [output]
 * @property {{kind: ToolErrorKind, message: string}} [error]
 * @property {number} durationMs
 *
 * @typedef {object} Usage
 * @property {number} inputTokens
 * @property {number} outputTokens
 * @property {number} costUsd
 */

/** 工具错误的处理策略：由 loop 读取，决定「回给模型 / 重试 / 中断」 */
export const ERROR_POLICY = {
    validation: { toModel: true, retry: false, note: '参数不合法，把错误信息回给模型让它改' },
    business: { toModel: true, retry: false, note: '业务上不存在或不允许，让模型换策略' },
    network: { toModel: true, retry: true, maxRetry: 2, note: '外部依赖不可达，有限重试后回给模型' },
    timeout: { toModel: true, retry: true, maxRetry: 1, note: '超时，重试一次再回给模型' },
    permission: { toModel: true, retry: false, note: '权限不足，明确告知模型不要重试' },
    internal: { toModel: false, retry: false, fatal: true, note: '工具自身 bug，立即中断并上报' },
};

/** 把任意异常映射成工具错误类型。默认 internal，因为未知错误重试通常只是放大问题。 */
export function classifyError(e) {
    if (e && typeof e === 'object' && e.kind) return e.kind;
    const msg = String(e && e.message ? e.message : e);
    if (/timeout|ETIMEDOUT|timed out/i.test(msg)) return 'timeout';
    if (/ECONNREFUSED|ENOTFOUND|EAI_AGAIN|fetch failed|socket hang up/i.test(msg)) return 'network';
    if (/permission|EACCES|forbidden|403/i.test(msg)) return 'permission';
    if (/invalid|must be|required|expected/i.test(msg)) return 'validation';
    return 'internal';
}
