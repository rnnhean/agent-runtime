/**
 * MCP 客户端：通过 stdio 与 MCP server 通信（JSON-RPC 2.0）。
 *
 * 为什么自己实现而不引 SDK：
 *   MCP 的核心就是「一行一个 JSON-RPC 消息」。自己实现能看清 initialize 握手、
 *   tools/list、tools/call 三个方法到底传了什么，而不是把它当成黑盒。
 *   这也是面试里「你懂 MCP 吗」和「你会用 MCP SDK 吗」的区别。
 *
 * 协议要点（按 MCP 2024-11-05 规范）：
 *   1. 连接后必须先 initialize，再发 notifications/initialized
 *   2. tools/list 返回 { tools: [{ name, description, inputSchema }] }
 *   3. tools/call 入参 { name, arguments }，返回 { content: [{type:'text', text}], isError }
 */
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';

export class McpClient {
    /**
     * @param {object} o
     * @param {string} o.command 可执行文件
     * @param {string[]} [o.args]
     * @param {Record<string,string>} [o.env]
     * @param {number} [o.timeoutMs=10000]
     */
    constructor({ command, args = [], env, timeoutMs = 10_000 }) {
        this.command = command;
        this.args = args;
        this.env = env;
        this.timeoutMs = timeoutMs;
        this.proc = null;
        this.nextId = 1;
        this.pending = new Map();
        this.serverInfo = null;
    }

    async connect() {
        this.proc = spawn(this.command, this.args, {
            stdio: ['pipe', 'pipe', 'pipe'],
            env: { ...process.env, ...this.env },
            shell: process.platform === 'win32',
        });

        const rl = createInterface({ input: this.proc.stdout });
        rl.on('line', (line) => {
            const t = line.trim();
            if (!t) return;
            let msg;
            try {
                msg = JSON.parse(t);
            } catch {
                return; // 有些 server 会往 stdout 写日志，忽略非法行
            }
            if (msg.id != null && this.pending.has(msg.id)) {
                const { resolve, reject, timer } = this.pending.get(msg.id);
                clearTimeout(timer);
                this.pending.delete(msg.id);
                if (msg.error) reject(Object.assign(new Error(msg.error.message || 'MCP error'), { code: msg.error.code }));
                else resolve(msg.result);
            }
        });

        this.proc.on('exit', (code) => {
            for (const { reject, timer } of this.pending.values()) {
                clearTimeout(timer);
                reject(new Error(`MCP server 退出（code=${code}）`));
            }
            this.pending.clear();
        });

        // 1) initialize
        const init = await this.request('initialize', {
            protocolVersion: '2024-11-05',
            capabilities: { tools: {} },
            clientInfo: { name: 'agent-harness', version: '0.1.0' },
        });
        this.serverInfo = init?.serverInfo || null;

        // 2) 通知（无 id，不需要回复）
        this.notify('notifications/initialized');
        return this;
    }

    notify(method, params) {
        this.proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', method, params }) + '\n');
    }

    request(method, params) {
        const id = this.nextId++;
        return new Promise((resolve, reject) => {
            const timer = setTimeout(() => {
                this.pending.delete(id);
                reject(Object.assign(new Error(`MCP 请求超时：${method}`), { kind: 'timeout' }));
            }, this.timeoutMs);
            this.pending.set(id, { resolve, reject, timer });
            this.proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
        });
    }

    /** 拉取工具列表，转成本项目 Tool 的形状 */
    async listTools() {
        const r = await this.request('tools/list', {});
        return (r?.tools || []).map((t) => ({
            name: `mcp__${t.name}`,
            description: `[MCP] ${t.description || t.name}`,
            parameters: t.inputSchema || { type: 'object', properties: {} },
            __mcp: { remoteName: t.name },
        }));
    }

    /** 调用远端工具，返回值统一转成字符串（多块内容合并） */
    async callTool(remoteName, args) {
        const r = await this.request('tools/call', { name: remoteName, arguments: args });
        const text = (r?.content || [])
            .map((c) => (c.type === 'text' ? c.text : `[${c.type}]`))
            .join('\n');
        if (r?.isError) throw Object.assign(new Error(text || 'MCP 工具返回错误'), { kind: 'business' });
        return text;
    }

    async close() {
        if (!this.proc) return;
        try {
            this.proc.stdin.end();
        } catch {
            /* ignore */
        }
        await new Promise((r) => {
            const t = setTimeout(() => {
                try {
                    this.proc.kill();
                } catch {
                    /* ignore */
                }
                r();
            }, 1000);
            this.proc.on('exit', () => {
                clearTimeout(t);
                r();
            });
        });
        this.proc = null;
    }
}

/**
 * 把一组 MCP 工具注册进 ToolRegistry。
 * 命名统一加 mcp__ 前缀，避免与本地工具撞名；被 deny 时按原名也拦得住（见 tools.mjs）。
 */
export function registerMcpTools(registry, client, tools) {
    for (const t of tools) {
        registry.register({
            name: t.name,
            description: t.description,
            parameters: t.parameters,
            timeoutMs: 30_000,
            run: async (args) => client.callTool(t.__mcp.remoteName, args),
        });
    }
    return tools.map((t) => t.name);
}
