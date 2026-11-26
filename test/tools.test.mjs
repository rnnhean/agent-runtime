import assert from 'node:assert/strict';
import { test } from 'node:test';

import { ToolRegistry, defineTool } from '../src/core/tools.mjs';
import { classifyError, ERROR_POLICY } from '../src/core/types.mjs';

function registry(tools) {
    const r = new ToolRegistry();
    tools.forEach((t) => r.register(defineTool(t)));
    return r;
}

const okTool = {
    name: 'ok',
    description: 'ok',
    parameters: { type: 'object', properties: {} },
    run: async () => ({ value: 1 }),
};

test('成功调用返回结构化结果', async () => {
    const r = registry([okTool]);
    const res = await r.execute({ id: 'c1', name: 'ok', args: {} });
    assert.equal(res.ok, true);
    assert.deepEqual(res.output, { value: 1 });
    assert.equal(res.toolCallId, 'c1');
});

test('参数校验失败 → validation，且不执行 run', async () => {
    let called = false;
    const r = registry([
        {
            name: 'v',
            description: 'v',
            parameters: { type: 'object', properties: {} },
            parse: () => ({ ok: false, error: 'orderId 必填' }),
            run: async () => {
                called = true;
            },
        },
    ]);
    const res = await r.execute({ id: 'c1', name: 'v', args: {} });
    assert.equal(res.error.kind, 'validation');
    assert.equal(called, false, '参数校验失败不应执行工具');
});

test('业务错误 → business', async () => {
    const r = registry([
        {
            name: 'b',
            description: 'b',
            parameters: { type: 'object', properties: {} },
            run: async () => {
                throw Object.assign(new Error('订单不存在'), { kind: 'business' });
            },
        },
    ]);
    const res = await r.execute({ id: 'c1', name: 'b', args: {} });
    assert.equal(res.error.kind, 'business');
    assert.match(res.error.message, /不存在/);
});

test('超时 → timeout，且只重试配置次数', async () => {
    let n = 0;
    const r = registry([
        {
            name: 'slow',
            description: 's',
            parameters: { type: 'object', properties: {} },
            timeoutMs: 20,
            retries: 2,
            run: async () => {
                n++;
                await new Promise((res) => setTimeout(res, 200));
            },
        },
    ]);
    const res = await r.execute({ id: 'c1', name: 'slow', args: {} });
    assert.equal(res.error.kind, 'timeout');
    assert.equal(n, 3, '首次 + 2 次重试');
});

test('内部错误不重试（重试只会放大问题）', async () => {
    let n = 0;
    const r = registry([
        {
            name: 'bug',
            description: 'b',
            parameters: { type: 'object', properties: {} },
            retries: 3,
            run: async () => {
                n++;
                throw new TypeError('undefined is not a function');
            },
        },
    ]);
    const res = await r.execute({ id: 'c1', name: 'bug', args: {} });
    assert.equal(res.error.kind, 'internal');
    assert.equal(n, 1);
    assert.equal(ERROR_POLICY.internal.fatal, true);
});

test('白名单：不在 allow 内的工具被拒绝，且不执行', async () => {
    let called = false;
    const r = registry([
        {
            name: 'danger',
            description: 'd',
            parameters: { type: 'object', properties: {} },
            run: async () => {
                called = true;
            },
        },
    ]);
    const res = await r.execute({ id: 'c1', name: 'danger', args: {} }, { allow: ['safe'] });
    assert.equal(res.error.kind, 'permission');
    assert.equal(called, false);
});

test('黑名单优先于白名单', async () => {
    const r = registry([okTool]);
    const res = await r.execute({ id: 'c1', name: 'ok', args: {} }, { allow: ['ok'], deny: ['ok'] });
    assert.equal(res.error.kind, 'permission');
});

test('未知工具 → validation', async () => {
    const r = registry([okTool]);
    const res = await r.execute({ id: 'c1', name: 'nope', args: {} });
    assert.equal(res.error.kind, 'validation');
});

test('specs 按 allow/deny 过滤', () => {
    const r = registry([
        okTool,
        { name: 'other', description: 'o', parameters: { type: 'object', properties: {} }, run: async () => 1 },
    ]);
    assert.equal(r.specs().length, 2);
    assert.equal(r.specs({ allow: ['ok'] }).length, 1);
    assert.equal(r.specs({ deny: ['ok'] }).length, 1);
});

test('classifyError 把常见错误分对类', () => {
    assert.equal(classifyError(new Error('timeout after 10ms')), 'timeout');
    assert.equal(classifyError(new Error('fetch failed')), 'network');
    assert.equal(classifyError(new Error('EACCES: permission denied')), 'permission');
    assert.equal(classifyError(new Error('unknowable')), 'internal');
});
