import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { createAgent } from '../src/harness/agent.mjs';
import { ScriptedClient, toAnthropicMessages, toOpenAIMessages } from '../src/core/llm.mjs';
import { buildExampleTools } from '../examples/tools.mjs';
import { EventLog } from '../src/core/eventlog.mjs';
import { createTrace, Metrics } from '../src/observability/trace.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SKILLS = path.join(HERE, '..', 'examples', 'skills');
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'ah-ag-'));

test('Agent：技能加载 + 工具调用 + 结尾', async () => {
    const dir = tmp();
    const llm = new ScriptedClient([
        [{ type: 'text', text: '查订单' }, { type: 'tool_use', id: 't1', name: 'query_order', input: { orderId: 'A1001' } }],
        [{ type: 'tool_use', id: 't2', name: 'query_logistics', input: { orderId: 'A1001' } }],
        [{ type: 'text', text: 'A1001 正在派送中' }],
    ]);
    const agent = createAgent({
        llm,
        tools: buildExampleTools(),
        eventDir: dir,
        system: '客服助手',
        skillsDir: SKILLS,
    });
    const r = await agent.run('我的订单 A1001 到哪了');
    assert.equal(r.stopReason, 'answer');
    assert.match(r.answer, /派送/);
    assert.deepEqual(r.skills, ['order-lookup']);

    const evs = EventLog.read(dir, r.runId);
    assert.ok(evs.some((e) => e.type === 'skills_selected'));
    assert.equal(evs.filter((e) => e.type === 'tool_result').length, 2);
});

test('Agent：技能声明的工具白名单生效（未声明的工具不可用）', async () => {
    const dir = tmp();
    // 临时技能只声明 query_order；模型却想调 search_policy
    const skillRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ah-skill-'));
    fs.mkdirSync(path.join(skillRoot, 'narrow'), { recursive: true });
    fs.writeFileSync(
        path.join(skillRoot, 'narrow', 'SKILL.md'),
        `---\nname: narrow-order\ndescription: 查询订单状态\n工具: x\ntools: [query_order]\n---\n\n只查订单。\n`,
    );
    const llm = new ScriptedClient([
        [{ type: 'tool_use', id: 't1', name: 'search_policy', input: { query: '补偿' } }],
        [{ type: 'text', text: '完成' }],
    ]);
    const agent = createAgent({ llm, tools: buildExampleTools(), eventDir: dir, system: 's', skillsDir: skillRoot });
    const r = await agent.run('查询订单状态');
    const evs = EventLog.read(dir, r.runId);
    const tr = evs.find((e) => e.type === 'tool_result');
    assert.equal(tr.result.error.kind, 'permission', '技能没声明 search_policy，应被拦');
});

test('Agent：委派子 Agent 只回结论，父上下文不含子过程', async () => {
    const dir = tmp();
    const subLlm = new ScriptedClient([
        [{ type: 'tool_use', id: 's1', name: 'query_logistics', input: { orderId: 'A1003' } }],
        [{ type: 'text', text: '子 Agent 结论：物流停在深圳分拨中心' }],
    ]);
    const rootLlm = new ScriptedClient([
        [{ type: 'tool_use', id: 'r1', name: 'delegate_logistics', input: { task: '查 A1003 的物流' } }],
        [{ type: 'text', text: '综合结论：物流在深圳分拨中心' }],
    ]);

    const base = createAgent({ llm: rootLlm, tools: buildExampleTools(), eventDir: dir, system: 'root' });
    const delegate = base.asTool({
        name: 'delegate_logistics',
        description: '委派子 Agent 查物流',
        subLlm,
        subTools: buildExampleTools(),
        subSystem: '子 Agent',
        eventDir: dir,
    });

    const parent = createAgent({ llm: rootLlm, tools: [...buildExampleTools(), delegate], eventDir: dir, system: 'root' });
    const r = await parent.run('订单 A1003 的物流怎么样');

    assert.equal(r.stopReason, 'answer');
    const evs = EventLog.read(dir, r.runId);
    const toolRes = evs.filter((e) => e.type === 'tool_result' && e.result.name === 'delegate_logistics');
    assert.equal(toolRes.length, 1);
    assert.match(JSON.stringify(toolRes[0].result.output), /深圳分拨中心/);
    // 父 run 的 llm_response 里不应出现子 Agent 的工具调用细节
    const parentTurns = evs.filter((e) => e.type === 'llm_response');
    assert.ok(parentTurns.every((t) => !(t.toolCalls || []).some((c) => c.name === 'query_logistics')), '父上下文不该被子 Agent 的工具调用污染');
});

test('LLM 转换：Anthropic 形状', () => {
    const out = toAnthropicMessages([
        { role: 'user', content: 'hi' },
        { role: 'assistant', content: [{ type: 'tool_use', id: 'x', name: 'f', input: { a: 1 } }] },
        { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'x', content: 'ok' }] },
    ]);
    assert.deepEqual(out[0], { role: 'user', content: [{ type: 'text', text: 'hi' }] });
    assert.equal(out[1].content[0].type, 'tool_use');
    assert.equal(out[2].content[0].tool_use_id, 'x');
});

test('LLM 转换：OpenAI 形状（tool_result 必须拆成独立消息）', () => {
    const out = toOpenAIMessages('sys', [
        { role: 'user', content: 'hi' },
        { role: 'assistant', content: [{ type: 'tool_use', id: 'x', name: 'f', input: { a: 1 } }] },
        { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'x', content: 'ok' }] },
    ]);
    assert.equal(out[0].role, 'system');
    assert.equal(out[2].role, 'assistant');
    assert.equal(out[2].tool_calls[0].function.name, 'f');
    assert.equal(out[3].role, 'tool');
    assert.equal(out[3].tool_call_id, 'x');
});

test('轨迹与指标：从真实事件派生', async () => {
    const dir = tmp();
    const llm = new ScriptedClient([
        // A9999 格式合法但不存在 → business 错误（区别于格式错误导致的 validation）
        [{ type: 'tool_use', id: 't1', name: 'query_order', input: { orderId: 'A9999' } }],
        [{ type: 'text', text: '订单不存在' }],
    ]);
    const agent = createAgent({ llm, tools: buildExampleTools(), eventDir: dir, system: 's' });
    const r = await agent.run('查 A9999');

    const evs = EventLog.read(dir, r.runId);
    const trace = createTrace(evs);
    assert.ok(trace.some((x) => x.kind === 'llm'));
    assert.ok(trace.some((x) => x.kind === 'tool' && x.ok === false));

    const m = new Metrics();
    m.observeRun(evs);
    assert.equal(m.runs, 1);
    assert.equal(m.runsOk, 1);
    assert.equal(m.toolErrors.business, 1, '订单不存在应记为 business 错误');
    assert.match(m.renderPrometheus(), /harness_tool_errors_total\{kind="business"\} 1/);
});
