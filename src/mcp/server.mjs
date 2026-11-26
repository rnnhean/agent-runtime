#!/usr/bin/env node
/**
 * 一个最小的 MCP server：把 harness 本身暴露给别的 Agent（比如 Claude Code）调用。
 *
 * 这件事的意义：让「我的 Agent」变成「别人的工具」。面试里「你懂 MCP 吗」有两种答法——
 * 会写 client 是「我会用」，会写 server 是「我能被别人用」。后者少得多。
 *
 * 协议：stdio + JSON-RPC 2.0，一行一条消息。只实现 tools 能力。
 * 严格性：未 initialize 就调用工具 → 返回错误，而不是假装成功。
 */
import { createInterface } from 'node:readline';
import { buildExampleTools } from '../../examples/tools.mjs';

const SERVER_INFO = { name: 'agent-harness', version: '0.1.0' };

let initialized = false;
const tools = buildExampleTools();
const toolMap = new Map(tools.map((t) => [t.name, t]));

function send(msg) {
    process.stdout.write(JSON.stringify(msg) + '\n');
}

function reply(id, result) {
    send({ jsonrpc: '2.0', id, result });
}

function replyError(id, code, message) {
    send({ jsonrpc: '2.0', id, error: { code, message } });
}

async function handle(msg) {
    const { id, method, params } = msg;
    const isNotification = id == null;

    if (method === 'initialize') {
        initialized = true;
        reply(id, {
            protocolVersion: '2024-11-05',
            capabilities: { tools: { listChanged: false } },
            serverInfo: SERVER_INFO,
        });
        return;
    }

    if (method === 'notifications/initialized') return;

    if (method === 'tools/list') {
        if (!initialized) return replyError(id, -32002, '未初始化');
        reply(id, {
            tools: tools.map((t) => ({ name: t.name, description: t.description, inputSchema: t.parameters })),
        });
        return;
    }

    if (method === 'tools/call') {
        if (!initialized) return replyError(id, -32002, '未初始化');
        const { name, arguments: args } = params || {};
        const tool = toolMap.get(name);
        if (!tool) return replyError(id, -32602, `未知工具 ${name}`);
        try {
            const output = await tool.run(args || {});
            reply(id, { content: [{ type: 'text', text: typeof output === 'string' ? output : JSON.stringify(output) }], isError: false });
        } catch (e) {
            reply(id, { content: [{ type: 'text', text: String(e.message || e) }], isError: true });
        }
        return;
    }

    if (method === 'ping') {
        reply(id, {});
        return;
    }

    if (!isNotification) replyError(id, -32601, `不支持的方法 ${method}`);
}

const rl = createInterface({ input: process.stdin });
rl.on('line', (line) => {
    const t = line.trim();
    if (!t) return;
    let msg;
    try {
        msg = JSON.parse(t);
    } catch {
        return;
    }
    handle(msg).catch((e) => {
        if (msg.id != null) replyError(msg.id, -32603, String(e.message || e));
    });
});
