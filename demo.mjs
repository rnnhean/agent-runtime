/**
 * 离线演示：不联网、不花钱、结果确定。
 * 演示三件事：技能按需加载、工具错误分类、工作流中断 + 恢复。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { createAgent } from './src/harness/agent.mjs';
import { ScriptedClient } from './src/core/llm.mjs';
import { buildExampleTools } from './examples/tools.mjs';
import { defineWorkflow, runWorkflow, Interrupt } from './src/core/machine.mjs';
import { EventLog } from './src/core/eventlog.mjs';
import { createTrace } from './src/observability/trace.mjs';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ah-demo-'));
console.log(`事件目录：${dir}\n`);

// ---------- 1. 技能加载 + 工具错误分类 ----------
console.log('=== 1. 技能加载与工具错误分类 ===');
const llm = new ScriptedClient([
    [{ type: 'tool_use', id: 'a', name: 'query_order', input: { orderId: 'A9999' } }],
    [{ type: 'tool_use', id: 'b', name: 'query_order', input: { orderId: 'bad-format' } }],
    [{ type: 'text', text: '订单号有问题，请确认后再试。' }],
]);
const agent = createAgent({ llm, tools: buildExampleTools(), eventDir: dir, system: '客服助手', skillsDir: './examples/skills' });
const r = await agent.run('帮我查一下订单 A9999');

console.log(`加载技能：${r.skills.join(', ') || '（无）'}`);
for (const line of createTrace(EventLog.read(dir, r.runId))) console.log(`  [${line.kind}] ${line.text}`);
console.log();

// ---------- 2. 工作流中断 + 恢复 ----------
console.log('=== 2. 工作流中断与恢复 ===');
const workflow = defineWorkflow({
    name: 'refund',
    entry: 'investigate',
    nodes: {
        investigate: async () => ({ goto: 'approve', state: { amount: 1299 } }),
        approve: async (ctx) => {
            if (!ctx.humanAnswer) throw new Interrupt(`补偿金额 ${ctx.state.amount} 超过 200 上限，是否批准？`, { options: ['批准', '拒绝'] });
            return { goto: 'reply', state: { approved: ctx.humanAnswer === '批准' } };
        },
        reply: async (ctx) => ({ done: true, output: ctx.state.approved ? '已批准，处理中' : '已拒绝，已告知用户原因' }),
    },
});

const first = await runWorkflow({ workflow, eventDir: dir, task: '订单 A1003 要补偿' });
console.log(`第一次运行：${first.status} — ${first.question}`);

const second = await runWorkflow({ workflow, eventDir: dir, runId: first.runId, humanAnswer: '批准' });
console.log(`恢复运行：${second.status} — ${second.answer}`);
console.log(`执行的节点：${second.visited.join(' → ')}（investigate 未重复执行）`);
console.log(`\n事件条数：${EventLog.read(dir, first.runId).length}`);
