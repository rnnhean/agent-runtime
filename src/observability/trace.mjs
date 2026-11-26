/**
 * 轨迹（trace）与指标。
 *
 * 两者解决的是不同问题，不能混：
 *   trace  —— 一次运行内部「哪一步慢、哪一步错、为什么」，排障用
 *   metrics —— 跨运行的聚合（成功率、各错误类型计数、耗时分布），告警用
 *
 * 刻意不做：用 OTel SDK。理由是这会引入一堆依赖和一个 exporter 配置；
 * 本项目的事件流本身已是结构化数据，接到 OTel 只是转换问题，不该让核心依赖它。
 */

/**
 * 从事件派生一个可读的轨迹视图。
 * 这是面板/CLI 唯一需要的数据结构——不直接暴露原始事件，避免前端解析耦合。
 */
export function createTrace(events) {
    const out = [];
    let turn = 0;
    for (const e of events) {
        switch (e.type) {
            case 'run_started':
                out.push({ t: e.at, kind: 'start', text: `任务：${trunc(e.task)}`, mode: e.mode });
                break;
            case 'skills_selected':
                if (e.skills?.length) out.push({ t: e.at, kind: 'skills', text: `加载技能：${e.skills.join(', ')}` });
                break;
            case 'node_enter':
                out.push({ t: e.at, kind: 'node', text: `进入节点 ${e.node}` });
                break;
            case 'llm_response':
                turn = e.turn;
                out.push({
                    t: e.at,
                    kind: 'llm',
                    turn: e.turn,
                    text: trunc(e.text) || '（无文本，仅工具调用）',
                    calls: (e.toolCalls || []).map((c) => `${c.name}(${trunc(JSON.stringify(c.args), 60)})`),
                    tokens: e.usage ? `${e.usage.inputTokens}→${e.usage.outputTokens}` : '',
                });
                break;
            case 'tool_result': {
                const r = e.result;
                out.push({
                    t: e.at,
                    kind: 'tool',
                    turn: e.turn,
                    text: `${r.name} ${r.ok ? 'OK' : `失败(${r.error.kind})`} ${r.durationMs}ms`,
                    detail: r.ok ? trunc(JSON.stringify(r.output), 120) : r.error.message,
                    ok: r.ok,
                });
                break;
            }
            case 'interrupt':
                out.push({ t: e.at, kind: 'interrupt', text: `等待人工：${e.question}` });
                break;
            case 'resume':
                out.push({ t: e.at, kind: 'resume', text: `人工答复：${trunc(e.answer)}` });
                break;
            case 'run_finished':
                out.push({ t: e.at, kind: 'end', text: `结束：${e.status}${e.answer ? ` — ${trunc(e.answer)}` : ''}` });
                break;
            default:
                break;
        }
    }
    return out;
}

export class TraceRecorder {
    constructor() {
        this.items = [];
    }

    push(x) {
        this.items.push(x);
    }

    toText() {
        return this.items.map((x) => `[${x.kind}] ${x.text}`).join('\n');
    }
}

/**
 * 跨运行的指标聚合。与 agent-compaction 的 Metrics 同构，但多了「工具错误类型」维度——
 * 因为「哪个工具最常失败、失败成什么样」是运维最先要看的。
 */
export class Metrics {
    constructor() {
        this.runs = 0;
        this.finished = 0;
        this.runsOk = 0;
        this.runsFailed = 0;
        this.runsInterrupted = 0;
        this.turns = 0;
        this.toolCalls = 0;
        this.toolErrors = {};
        this.inputTokens = 0;
        this.outputTokens = 0;
        this.durationMs = 0;
    }

    /** @param {object[]} events 一次运行的完整事件 */
    observeRun(events) {
        this.runs++;
        let started = 0;
        let finished = 0;
        for (const e of events) {
            if (e.type === 'run_started') started = Date.parse(e.at);
            if (e.type === 'run_finished') {
                finished = Date.parse(e.at);
                this.finished++;
                if (e.status === 'ok') this.runsOk++;
                else if (e.status === 'interrupted') this.runsInterrupted++;
                else this.runsFailed++;
            }
            if (e.type === 'llm_response') {
                this.turns++;
                this.inputTokens += e.usage?.inputTokens || 0;
                this.outputTokens += e.usage?.outputTokens || 0;
            }
            if (e.type === 'tool_result') {
                this.toolCalls++;
                if (!e.result?.ok) {
                    const k = e.result?.error?.kind || 'unknown';
                    this.toolErrors[k] = (this.toolErrors[k] || 0) + 1;
                }
            }
        }
        if (started && finished) this.durationMs += finished - started;
    }

    renderPrometheus() {
        const L = [];
        const g = (n, h, v, extra = '') => L.push(`# HELP ${n} ${h}`, `# TYPE ${n} ${extra || 'counter'}`, `${n} ${v}`);
        g('harness_runs_total', '运行总数', this.runs);
        g('harness_runs_ok_total', '成功运行数', this.runsOk);
        g('harness_runs_failed_total', '失败运行数', this.runsFailed);
        g('harness_runs_interrupted_total', '中断运行数', this.runsInterrupted);
        g('harness_turns_total', 'LLM 轮次总数', this.turns);
        g('harness_tool_calls_total', '工具调用总数', this.toolCalls);
        L.push('# HELP harness_tool_errors_total 按错误类型统计的工具失败', '# TYPE harness_tool_errors_total counter');
        for (const [k, v] of Object.entries(this.toolErrors)) L.push(`harness_tool_errors_total{kind="${k}"} ${v}`);
        g('harness_input_tokens_total', '输入 token 累计', this.inputTokens);
        g('harness_output_tokens_total', '输出 token 累计', this.outputTokens);
        g('harness_run_duration_seconds_sum', '运行耗时累计（秒）', (this.durationMs / 1000).toFixed(3));
        g('harness_run_duration_seconds_count', '运行耗时采样数', this.finished);
        g('harness_success_ratio', '成功率', this.finished ? (this.runsOk / this.finished).toFixed(4) : '0', 'gauge');
        return L.join('\n') + '\n';
    }
}

function trunc(s, n = 100) {
    const t = String(s ?? '').replace(/\s+/g, ' ').trim();
    return t.length > n ? `${t.slice(0, n)}…` : t;
}
