import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.EVENT_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'ah-srv-'));
process.env.SKILLS_DIR = './examples/skills';

const { createApp } = await import('../src/server.mjs');

let server;
let base;

before(async () => {
    server = createApp();
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    base = `http://127.0.0.1:${server.address().port}`;
});

after(() => new Promise((r) => server.close(r)));

test('/health 返回 ok 与模式', async () => {
    const r = await fetch(`${base}/health`);
    const j = await r.json();
    assert.equal(r.status, 200);
    assert.equal(j.ok, true);
});

test('/api/run 立刻返回 runId（不阻塞），稍后可查轨迹', async () => {
    const r = await fetch(`${base}/api/run`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ task: '查一下订单 A1001 到哪了', mode: 'offline' }),
    });
    assert.equal(r.status, 202);
    const j = await r.json();
    assert.ok(j.runId, '应立即返回 runId');

    // 轮询直到出现 run_finished（最多 5 秒）
    let events = [];
    for (let i = 0; i < 50; i++) {
        const t = await fetch(`${base}/api/runs/${j.runId}?raw=1`);
        if (t.status === 200) {
            const d = await t.json();
            events = d.events || [];
            if (events.some((e) => e.type === 'run_finished')) break;
        }
        await new Promise((res) => setTimeout(res, 100));
    }
    assert.ok(events.some((e) => e.type === 'run_finished'), '运行应完成');
});

test('/api/run 缺 task 返回 400', async () => {
    const r = await fetch(`${base}/api/run`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
    assert.equal(r.status, 400);
});

test('/api/runs 列表与 /metrics 可用', async () => {
    const list = await (await fetch(`${base}/api/runs`)).json();
    assert.ok(Array.isArray(list.runs));
    const m = await fetch(`${base}/metrics`);
    const text = await m.text();
    assert.match(text, /harness_runs_total \d+/);
});

test('未知 run 返回 404', async () => {
    const r = await fetch(`${base}/api/runs/nonexistent`);
    assert.equal(r.status, 404);
});
