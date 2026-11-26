import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { EventLog, fold, validate } from '../src/core/eventlog.mjs';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'ah-'));
const id = () => `t${Math.random().toString(36).slice(2, 8)}`;

test('事件日志：追加写、读回、seq 连续', () => {
    const dir = tmp();
    const log = new EventLog(dir);
    log.append('run_started', { task: 'x', mode: 'offline' });
    log.append('node_enter', { node: 'a' });
    const evs = EventLog.read(dir, log.runId);
    assert.equal(evs.length, 2);
    assert.deepEqual(evs.map((e) => e.seq), [1, 2]);
    assert.equal(evs[0].type, 'run_started');
});

test('fold：从事件重建状态', () => {
    const dir = tmp();
    const log = new EventLog(dir);
    log.append('run_started', { task: '查订单', mode: 'live' });
    log.append('llm_response', { turn: 1, text: '好的', toolCalls: [{ id: 'c1', name: 'query_order', args: {} }], usage: { inputTokens: 100, outputTokens: 20 } });
    log.append('tool_result', { turn: 1, result: { toolCallId: 'c1', name: 'query_order', ok: true, durationMs: 5 } });
    log.append('run_finished', { status: 'ok', answer: '完成' });
    const st = fold(EventLog.read(dir, log.runId));
    assert.equal(st.status, 'ok');
    assert.equal(st.task, '查订单');
    assert.equal(st.turns, 1);
    assert.equal(st.usage.inputTokens, 100);
    assert.equal(st.toolCalls.length, 1);
});

test('fold：中断与恢复配对', () => {
    const dir = tmp();
    const log = new EventLog(dir);
    log.append('run_started', { task: 't', mode: 'offline' });
    log.append('interrupt', { node: 'approve', question: '批准吗？', options: ['批准', '拒绝'] });
    log.append('run_finished', { status: 'interrupted' });
    assert.equal(fold(EventLog.read(dir, log.runId)).pendingInterrupt.question, '批准吗？');

    const log2 = new EventLog(dir, log.runId);
    log2.append('resume', { node: 'approve', answer: '批准' });
    assert.equal(fold(EventLog.read(dir, log.runId)).pendingInterrupt, null);
});

test('validate：孤儿 tool_result 会被发现', () => {
    const dir = tmp();
    const log = new EventLog(dir);
    log.append('run_started', { task: 't', mode: 'offline' });
    log.append('tool_result', { turn: 1, result: { toolCallId: 'ghost', name: 'x', ok: true, durationMs: 1 } });
    log.append('run_finished', { status: 'ok' });
    const errs = validate(EventLog.read(dir, log.runId));
    assert.ok(errs.some((e) => e.includes('ghost')), `应报孤儿 tool_result，实际：${errs}`);
});

test('validate：合法事件流无错误', () => {
    const dir = tmp();
    const log = new EventLog(dir);
    log.append('run_started', { task: 't', mode: 'offline' });
    log.append('llm_response', { turn: 1, text: '', toolCalls: [{ id: 'c1', name: 'x', args: {} }], usage: {} });
    log.append('tool_result', { turn: 1, result: { toolCallId: 'c1', name: 'x', ok: true, durationMs: 1 } });
    log.append('run_finished', { status: 'ok' });
    assert.deepEqual(validate(EventLog.read(dir, log.runId)), []);
});

test('list：按时间倒序列出运行', () => {
    const dir = tmp();
    for (const t of ['a', 'b']) {
        const log = new EventLog(dir);
        log.append('run_started', { task: t, mode: 'offline' });
        log.append('run_finished', { status: 'ok' });
    }
    const list = EventLog.list(dir);
    assert.equal(list.length, 2);
    assert.ok(list.every((r) => r.status === 'ok'));
});
