/**
 * 环境变量加载器（共享）。
 *
 * 安全约束：只把值写进 process.env 供进程内使用。
 * 本模块任何函数都不打印、不返回、不落盘变量的值——只返回「读到了几条」。
 */
import fs from 'node:fs';

export const DEFAULT_ENV_FILE = 'D:/20260916/allenvs/llm-env.txt';

/** @returns {{ok: boolean, count?: number, reason?: string}} */
export function loadEnvFile(file = process.env.AGENT_ENV_FILE || DEFAULT_ENV_FILE) {
    if (!fs.existsSync(file)) return { ok: false, reason: `找不到环境变量文件：${file}` };
    const raw = fs.readFileSync(file, 'utf8');
    let count = 0;
    for (const line of raw.split('\n')) {
        const m = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
        if (!m) continue;
        let v = m[2].trim();
        if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
        if (process.env[m[1]] == null) process.env[m[1]] = v;
        count++;
    }
    return { ok: true, count };
}

/**
 * 把 ANTHROPIC_* 映射成适配器统一使用的 LLM_*。
 * 只做映射，不校验值内容，不输出任何值。
 */
export function mapAnthropicToLlm() {
    if (!process.env.ANTHROPIC_AUTH_TOKEN || !process.env.ANTHROPIC_MODEL) {
        return { ok: false, reason: '缺少 ANTHROPIC_AUTH_TOKEN 或 ANTHROPIC_MODEL' };
    }
    process.env.LLM_API_KEY = process.env.ANTHROPIC_AUTH_TOKEN;
    process.env.LLM_BASE_URL = process.env.ANTHROPIC_BASE_URL || 'https://api.anthropic.com';
    return { ok: true };
}
