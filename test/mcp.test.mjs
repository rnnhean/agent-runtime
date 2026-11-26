import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { McpClient, registerMcpTools } from '../src/mcp/client.mjs';
import { ToolRegistry, defineTool } from '../src/core/tools.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SERVER = path.join(HERE, '..', 'src', 'mcp', 'server.mjs');

test('MCP：握手 → 列工具 → 调工具（端到端，真起子进程）', async (t) => {
    const client = new McpClient({ command: process.execPath, args: [SERVER] });
    await client.connect();
    t.after(() => client.close());

    assert.equal(client.serverInfo?.name, 'agent-harness');

    const tools = await client.listTools();
    assert.ok(tools.length >= 3, `应至少 3 个工具，实际 ${tools.length}`);
    assert.ok(tools.some((x) => x.name === 'mcp__query_order'));
    assert.ok(tools.every((x) => x.name.startsWith('mcp__')), '所有 MCP 工具应有前缀');
    assert.ok(tools.every((x) => x.parameters && x.parameters.type === 'object'));

    const order = await client.callTool('query_order', { orderId: 'A1001' });
    assert.match(order, /A1001/);
    assert.match(order, /shipped/);

    const policy = await client.callTool('search_policy', { query: '延迟' });
    assert.match(policy, /补偿/);
});

test('MCP：远端业务错误被转成抛错（让上层能分类）', async (t) => {
    const client = new McpClient({ command: process.execPath, args: [SERVER] });
    await client.connect();
    t.after(() => client.close());
    await assert.rejects(() => client.callTool('query_order', { orderId: 'X9999' }), /不存在/);
});

test('MCP 工具注册进 ToolRegistry 后可正常执行，且受白名单约束', async (t) => {
    const client = new McpClient({ command: process.execPath, args: [SERVER] });
    await client.connect();
    t.after(() => client.close());

    const reg = new ToolRegistry();
    const tools = await client.listTools();
    registerMcpTools(reg, client, tools);

    const res = await reg.execute({ id: 'c1', name: 'mcp__query_order', args: { orderId: 'A1004' } });
    assert.equal(res.ok, true);
    assert.match(String(res.output), /delivered/);

    const denied = await reg.execute({ id: 'c2', name: 'mcp__query_order', args: { orderId: 'A1004' } }, { deny: ['mcp__query_order'] });
    assert.equal(denied.error.kind, 'permission');
});

test('MCP server：未 initialize 就调工具应报错', async () => {
    // 直接起子进程并立刻发 tools/list，验证服务端严格性
    const { spawn } = await import('node:child_process');
    const proc = spawn(process.execPath, [SERVER], { stdio: ['pipe', 'pipe', 'ignore'] });
    const reply = await new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('超时')), 5000);
        proc.stdout.once('data', (b) => {
            clearTimeout(timer);
            resolve(JSON.parse(String(b).trim()));
        });
        proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }) + '\n');
    });
    proc.kill();
    assert.ok(reply.error, '未初始化应返回 error');
    assert.match(reply.error.message, /未初始化/);
});
