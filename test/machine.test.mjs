import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { defineWorkflow, runWorkflow, Interrupt } from '../src/core/machine.mjs';
import { EventLog, fold } from '../src/core/eventlog.mjs';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'ah-wf-'));

function twoNodeWorkflow() {
    const calls = [];
    const wf = defineWorkflow({
        name: 'test',
        entry: 'intake',
        nodes: {
            intake: async (ctx) => {
                calls.push('intake');
                return { goto: 'approve', state: { orderId: 'A1003', amount: 1299 } };
            },
            approve: async (ctx) => {
                calls.push('approve');
                if (!ctx.humanAnswer) {
                    throw new Interrupt('金额 1299 超过 200 的补偿上限，是否批准？', { options: ['批准', '拒绝'], context: { amount: 1299 } });
                }
                return { goto: 'reply', state: { approved: ctx.humanAnswer === '批准' } };
            },
            reply: async (ctx) => {
                calls.push('reply');
                return { done: true, output: ctx.state.approved ? '已批准并回复用户' : '已婉拒' };
            },
        },
    });
    return { wf, calls };
}

test('工作流：正常跑完', async () => {
    const dir = tmp();
    const wf = defineWorkflow({
        name: 'simple',
        entry: 'a',
        nodes: {
            a: async () => ({ goto: 'b' }),
            b: async () => ({ done: true, output: 'done' }),
        },
    });
    const r = await runWorkflow({ workflow: wf, eventDir: dir, task: 't' });
    assert.equal(r.status, 'ok');
    assert.equal(r.answer, 'done');
});

test('工作流：中断后停住，进程可退出', async () => {
    const dir = tmp();
    const { wf } = twoNodeWorkflow();
    const r = await runWorkflow({ workflow: wf, eventDir: dir, task: '退款' });
    assert.equal(r.status, 'interrupted');
    assert.match(r.question, /是否批准/);
    assert.deepEqual(r.options, ['批准', '拒绝']);

    const evs = EventLog.read(dir, r.runId);
    assert.equal(validateBasic(evs), true);
    assert.equal(fold(evs).pendingInterrupt.node, 'approve');
});

test('工作流：恢复后不重跑已完成的节点', async () => {
    const dir = tmp();
    const { wf, calls } = twoNodeWorkflow();
    const first = await runWorkflow({ workflow: wf, eventDir: dir, task: '退款' });
    calls.length = 0;

    const second = await runWorkflow({ workflow: wf, eventDir: dir, runId: first.runId, humanAnswer: '批准' });
    assert.equal(second.status, 'ok');
    assert.equal(second.answer, '已批准并回复用户');
    assert.ok(!calls.includes('intake'), `恢复时不应重跑 intake，实际调用：${calls.join(',')}`);
    assert.deepEqual(calls, ['approve', 'reply']);

    const evs = EventLog.read(dir, first.runId);
    assert.equal(evs.filter((e) => e.type === 'node_enter' && e.node === 'intake').length, 1, 'intake 只应进入一次');
});

test('工作流：重复 resume 不会重复执行', async () => {
    const dir = tmp();
    const { wf } = twoNodeWorkflow();
    const first = await runWorkflow({ workflow: wf, eventDir: dir, task: '退款' });
    await runWorkflow({ workflow: wf, eventDir: dir, runId: first.runId, humanAnswer: '批准' });
    const third = await runWorkflow({ workflow: wf, eventDir: dir, runId: first.runId, humanAnswer: '批准' });
    assert.equal(third.status, 'ok');
    assert.equal(third.resumedFrom, null, '已完成的 run 再 resume 应直接返回，不执行');
    const enters = EventLog.read(dir, first.runId).filter((e) => e.type === 'node_enter' && e.node === 'reply');
    assert.equal(enters.length, 1, 'reply 只执行一次');
});

test('工作流：节点抛普通异常 → failed，异常向上抛', async () => {
    const dir = tmp();
    const wf = defineWorkflow({
        name: 'boom',
        entry: 'a',
        nodes: {
            a: async () => {
                throw new Error('数据库炸了');
            },
        },
    });
    await assert.rejects(() => runWorkflow({ workflow: wf, eventDir: dir, task: 't' }), /数据库炸了/);
    const runs = EventLog.list(dir);
    assert.equal(runs[0].status, 'failed');
});

test('工作流：超过最大跳转次数会失败而不是死循环', async () => {
    const dir = tmp();
    const wf = defineWorkflow({
        name: 'loop',
        entry: 'a',
        maxTransitions: 3,
        nodes: { a: async () => ({ goto: 'b' }), b: async () => ({ goto: 'a' }) },
    });
    const r = await runWorkflow({ workflow: wf, eventDir: dir, task: 't' });
    assert.equal(r.status, 'failed');
    assert.match(String(r.error), /最大跳转/);
});

function validateBasic(evs) {
    return evs.filter((e) => e.type === 'interrupt').length === 1 && evs.filter((e) => e.type === 'run_finished').length === 1;
}
