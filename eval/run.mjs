/**
 * 真实模型演示 + 评测（不用 mock）。
 *
 * 判定式：每个 case 有明确验收条件，不是「感觉还行」。
 * 覆盖四类：正常查询、订单不存在（业务错误恢复）、格式错误（参数错误恢复）、需转人工。
 *
 * 用法：
 *   node eval/run.mjs               # 全部 case
 *   node eval/run.mjs --only=case_1
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { createAgent } from '../src/harness/agent.mjs';
import { anthropicClient, openaiCompatClient } from '../src/core/llm.mjs';
import { buildExampleTools } from '../examples/tools.mjs';
import { EventLog } from '../src/core/eventlog.mjs';
import { Metrics } from '../src/observability/trace.mjs';
import { loadEnvFile, mapAnthropicToLlm } from '../scripts/load-env.mjs';

const CASES = [
    {
        id: 'query_shipped',
        task: '我的订单 A1001 到哪了？',
        mustCall: ['query_order', 'query_logistics'],
        mustIncludeAny: ['派送', '运输', '分拨'],
        mustNotInclude: ['不存在'],
    },
    {
        id: 'order_missing',
        task: '帮我查一下订单 A9999',
        mustCall: ['query_order'],
        mustIncludeAny: ['不存在', '未找到', '查无'],
        mustNotInclude: [],
    },
    {
        id: 'bad_format',
        task: '查一下订单 hello123',
        mustCall: ['query_order'],
        mustIncludeAny: ['格式', '订单号', '确认'],
        mustNotInclude: [],
    },
    {
        id: 'policy_compensation',
        task: '订单 A1002 三天了还没发货，能补偿吗？',
        mustCall: ['query_order', 'search_policy'],
        mustIncludeAny: ['补偿', '200', '10%', '审批'],
        mustNotInclude: [],
    },
];

const env = loadEnvFile();
if (!env.ok) {
    console.error(env.reason);
    process.exit(2);
}

let client;
if (process.env.USE_OPENAI_COMPAT === '1') {
    client = openaiCompatClient({
        model: process.env.OPENAI_MODEL || process.env.LLM_MODEL || 'gpt-4o-mini',
        baseUrl: process.env.LLM_BASE_URL,
        keyEnv: 'LLM_API_KEY',
    });
} else {
    const mapped = mapAnthropicToLlm();
    if (!mapped.ok) {
        console.error(mapped.reason);
        process.exit(2);
    }
    client = anthropicClient({
        model: process.env.ANTHROPIC_MODEL,
        baseUrl: process.env.LLM_BASE_URL,
        keyEnv: 'LLM_API_KEY',
        maxTokens: 2048,
    });
}

const only = (process.argv.find((a) => a.startsWith('--only=')) || '').split('=')[1];
const list = only ? CASES.filter((c) => c.id === only) : CASES;

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ah-eval-'));
const metrics = new Metrics();
const rows = [];
let failed = 0;

for (const c of list) {
    const agent = createAgent({
        llm: client,
        tools: buildExampleTools(),
        eventDir: dir,
        system: '你是电商客服助手。需要数据必须调用工具，结论必须有工具依据。遇到参数或业务错误时，向用户说明清楚，不要编造。',
        skillsDir: './examples/skills',
        maxTurns: 8,
    });
    const t0 = Date.now();
    const r = await agent.run(c.task, { mode: 'live' });
    const elapsed = Date.now() - t0;

    const evs = EventLog.read(dir, r.runId);
    metrics.observeRun(evs);
    const called = evs.filter((e) => e.type === 'tool_result').map((e) => e.result.name);
    const answer = String(r.answer || '');

    const checks = {
        calls: c.mustCall.every((t) => called.includes(t)),
        include: !c.mustIncludeAny.length || c.mustIncludeAny.some((s) => answer.includes(s)),
        exclude: !c.mustNotInclude.some((s) => answer.includes(s)),
        finished: r.stopReason === 'answer',
    };
    const pass = Object.values(checks).every(Boolean);
    if (!pass) failed++;

    const usage = evs.filter((e) => e.type === 'llm_response').reduce(
        (a, e) => ({ in: a.in + (e.usage?.inputTokens || 0), out: a.out + (e.usage?.outputTokens || 0) }),
        { in: 0, out: 0 },
    );
    rows.push({ id: c.id, pass, checks, called, elapsed, usage, answer: answer.slice(0, 120) });

    console.log(
        `${pass ? '✅' : '❌'} ${c.id.padEnd(20)} ${String(elapsed).padStart(6)}ms  ` +
        `调用[${called.join(',')}]  ` +
        `工具齐全=${checks.calls ? 'OK' : 'FAIL'} 内容=${checks.include ? 'OK' : 'FAIL'} ` +
        `无否定=${checks.exclude ? 'OK' : 'FAIL'} 收尾=${checks.finished ? 'OK' : 'FAIL'}  ` +
        `token ${usage.in}→${usage.out}`,
    );
    if (!pass) console.log(`   答复：${answer.slice(0, 160)}`);
}

const outDir = path.resolve('results');
fs.mkdirSync(outDir, { recursive: true });
const stamp = new Date().toISOString().replace(/[:.]/g, '-');
fs.writeFileSync(
    path.join(outDir, `eval-${stamp}.json`),
    JSON.stringify({ model: 'live', rows, metrics: { runs: metrics.runs, ok: metrics.runsOk, errors: metrics.toolErrors } }, null, 2),
);
const md = [
    `# agent-harness 评测 ${new Date().toISOString().slice(0, 19)}（真实模型）`,
    '',
    '| case | 通过 | 工具齐全 | 内容 | 无否定 | 收尾 | 耗时 | token |',
    '|---|---|---|---|---|---|---:|---|',
    ...rows.map(
        (r) =>
            `| ${r.id} | ${r.pass ? '✅' : '❌'} | ${r.checks.calls ? '✅' : '❌'} | ${r.checks.include ? '✅' : '❌'} | ${r.checks.exclude ? '✅' : '❌'} | ${r.checks.finished ? '✅' : '❌'} | ${r.elapsed}ms | ${r.usage.in}→${r.usage.out} |`,
    ),
    '',
    `合计：${rows.length - failed}/${rows.length} 通过`,
].join('\n');
fs.writeFileSync(path.join(outDir, `eval-${stamp}.md`), md);

console.log(`\n${rows.length - failed}/${rows.length} 通过`);
console.log(`工具错误分布：${JSON.stringify(metrics.toolErrors)}`);
process.exit(failed ? 1 : 0);
