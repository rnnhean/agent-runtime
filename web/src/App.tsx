import { useCallback, useEffect, useState } from 'react';

/** 与 /api/runs 返回结构对应 */
interface RunRow {
  runId: string;
  task: string;
  mode: string;
  status: string;
  startedAt: string;
  finishedAt: string;
  events: number;
}

/** createTrace() 产出的轨迹项 */
interface TraceItem {
  t: string;
  kind: string;
  text: string;
  turn?: number;
  calls?: string[];
  tokens?: string;
  detail?: string;
  ok?: boolean;
}

const KIND_META: Record<string, { label: string; cls: string; icon: string }> = {
  start: { label: '开始', cls: 'k-start', icon: '▶' },
  skills: { label: '技能', cls: 'k-skill', icon: '◈' },
  node: { label: '节点', cls: 'k-node', icon: '▣' },
  llm: { label: '模型', cls: 'k-llm', icon: '✦' },
  tool: { label: '工具', cls: 'k-tool', icon: '⚙' },
  interrupt: { label: '中断', cls: 'k-int', icon: '⏸' },
  resume: { label: '恢复', cls: 'k-resume', icon: '↻' },
  end: { label: '结束', cls: 'k-end', icon: '■' },
};

const statusClass = (s: string) =>
  s === 'ok' ? 'ok' : s === 'interrupted' ? 'warn' : s === 'failed' ? 'bad' : 'muted';

export default function App() {
  const [runs, setRuns] = useState<RunRow[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [trace, setTrace] = useState<TraceItem[]>([]);
  const [task, setTask] = useState('我的订单 A1001 到哪了？');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [lastRunId, setLastRunId] = useState<string | null>(null);

  const loadRuns = useCallback(async () => {
    try {
      const j = await (await fetch('/api/runs')).json();
      setRuns(j.runs || []);
      setErr(null);
    } catch (e) {
      setErr((e as Error).message);
    }
  }, []);

  const loadTrace = useCallback(async (id: string) => {
    try {
      const j = await (await fetch(`/api/runs/${id}`)).json();
      if (j.error) {
        setErr(j.error);
        return;
      }
      setTrace(j.trace || []);
      setSelected(id);
      setErr(null);
    } catch (e) {
      setErr((e as Error).message);
    }
  }, []);

  useEffect(() => {
    loadRuns();
    const t = setInterval(loadRuns, 4000);
    return () => clearInterval(t);
  }, [loadRuns]);

  async function startRun() {
    setBusy(true);
    setErr(null);
    try {
      const r = await fetch('/api/run', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ task, mode: 'offline' }),
      });
      const j = await r.json();
      if (j.runId) setLastRunId(j.runId);
      // 轮询直到出现 run_finished
      for (let i = 0; i < 60; i++) {
        await new Promise((res) => setTimeout(res, 500));
        const d = await (await fetch(`/api/runs/${j.runId}`)).json();
        if (d.trace?.some((x: TraceItem) => x.kind === 'end')) {
          setTrace(d.trace);
          setSelected(j.runId);
          break;
        }
      }
      await loadRuns();
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  const counts = trace.reduce<Record<string, number>>((a, x) => {
    a[x.kind] = (a[x.kind] || 0) + 1;
    return a;
  }, {});

  return (
    <>
      <header>
        <h1>Agent Runtime</h1>
        <span className={`dot ${err ? '' : 'on'}`} aria-hidden />
        <span className="muted">{err ? `连接失败：${err}` : `${runs.length} 次运行`}</span>
      </header>

      <main>
        <section className="card span4">
          <h2>发起运行</h2>
          <textarea
            aria-label="任务"
            rows={3}
            value={task}
            onChange={(e) => setTask(e.target.value)}
            placeholder="输入任务，例如：我的订单 A1001 到哪了？"
          />
          <div className="row" style={{ marginTop: 10 }}>
            <button onClick={startRun} disabled={busy} data-testid="run">
              {busy ? '运行中…' : '发送'}
            </button>
            <button className="ghost" onClick={loadRuns}>刷新列表</button>
          </div>
          {lastRunId && <div className="muted" style={{ marginTop: 8, fontSize: 12 }}>最近一次：{lastRunId}</div>}

          <h2 style={{ marginTop: 20 }}>运行列表</h2>
          <table>
            <thead><tr><th>任务</th><th>状态</th><th>事件</th></tr></thead>
            <tbody data-testid="runs">
              {runs.length === 0 ? (
                <tr><td colSpan={3} className="muted">暂无运行</td></tr>
              ) : (
                runs.map((r) => (
                  <tr key={r.runId} onClick={() => loadTrace(r.runId)} className="clickable" data-testid={`run-${r.runId}`}>
                    <td title={r.runId}>{r.task.slice(0, 18)}</td>
                    <td><span className={`tag ${statusClass(r.status)}`}>{r.status}</span></td>
                    <td>{r.events}</td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </section>

        <section className="card span8">
          <h2>
            轨迹 {selected ? `· ${selected}` : ''}
            {trace.length > 0 && (
              <span className="muted" style={{ fontWeight: 400, marginLeft: 10, fontSize: 12 }}>
                模型 {counts.llm || 0} · 工具 {counts.tool || 0} · 中断 {counts.interrupt || 0}
              </span>
            )}
          </h2>
          {trace.length === 0 ? (
            <div className="muted">点左侧任意一次运行，或直接发起一次。</div>
          ) : (
            <ol className="timeline" data-testid="trace">
              {trace.map((x, i) => {
                const meta = KIND_META[x.kind] ?? { label: x.kind, cls: '', icon: '·' };
                return (
                  <li key={i} className={`tl-item ${meta.cls}`}>
                    <span className="tl-icon" aria-hidden>{meta.icon}</span>
                    <div className="tl-body">
                      <div className="tl-head">
                        <span className="tl-label">{meta.label}</span>
                        {x.turn != null && <span className="tl-turn">第 {x.turn} 轮</span>}
                        {x.tokens && <span className="tl-tokens">{x.tokens}</span>}
                        {x.ok === false && <span className="tag bad">失败</span>}
                      </div>
                      <div className="tl-text">{x.text}</div>
                      {x.calls && x.calls.length > 0 && (
                        <div className="tl-calls">
                          {x.calls.map((c, k) => <code key={k}>{c}</code>)}
                        </div>
                      )}
                      {x.detail && <div className="tl-detail">{x.detail}</div>}
                    </div>
                  </li>
                );
              })}
            </ol>
          )}
        </section>
      </main>
    </>
  );
}
