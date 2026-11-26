/**
 * 服务模式：对外提供运行、查看轨迹、指标、健康检查。
 *
 * 与 agent-compaction 的差异：那边是纯函数压缩；这边要**异步执行长任务**，
 * 所以必须「立刻返回 runId，后台跑，前端轮询/看轨迹」。同步等待 10 分钟是不可接受的。
 */
import { createServer } from 'node:http';
import { pathToFileURL, fileURLToPath } from 'node:url';
import path from 'node:path';
import fs from 'node:fs';

import { EventLog } from './core/eventlog.mjs';
import { createAgent } from './harness/agent.mjs';
import { createTrace, Metrics } from './observability/trace.mjs';
import { buildExampleTools } from '../examples/tools.mjs';
import { anthropicClient, ScriptedClient } from './core/llm.mjs';

const MAX_BODY = 2 * 1024 * 1024;
const EVENT_DIR = process.env.EVENT_DIR || './runs';

// React 控制台构建产物（web/dist）。未构建时给明确提示而不是白屏。
const DIST_DIR = [process.env.WEB_DIST_DIR, fileURLToPath(new URL('../web/dist', import.meta.url))].find((d) => {
    try {
        return d && fs.existsSync(path.join(d, 'index.html'));
    } catch {
        return false;
    }
}) || null;
const MIME = {
    '.html': 'text/html; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.svg': 'image/svg+xml',
    '.png': 'image/png',
    '.ico': 'image/x-icon',
    '.json': 'application/json; charset=utf-8',
};

const json = (res, code, body) => {
    const s = JSON.stringify(body);
    res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(s) });
    res.end(s);
};

const readBody = (req) =>
    new Promise((resolve, reject) => {
        let size = 0;
        const chunks = [];
        req.on('data', (c) => {
            size += c.length;
            if (size > MAX_BODY) {
                reject(Object.assign(new Error('请求体过大'), { status: 413 }));
                req.destroy();
                return;
            }
            chunks.push(c);
        });
        req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
        req.on('error', reject);
    });

/**
 * @param {object} [o]
 * @param {Metrics} [o.metrics]
 * @param {(mode:string)=>object} [o.makeLlm] 测试时注入脚本模型
 */
export function createApp({ metrics = new Metrics(), makeLlm } = {}) {
    const jobs = new Map(); // runId -> { status, promise }

    const defaultLlm = (mode) => {
        if (mode === 'offline') {
            return new ScriptedClient([
                [
                    { type: 'text', text: '查询订单' },
                    { type: 'tool_use', id: 't1', name: 'query_order', input: { orderId: 'A1001' } },
                ],
                [
                    { type: 'tool_use', id: 't2', name: 'query_logistics', input: { orderId: 'A1001' } },
                ],
                [{ type: 'text', text: '订单 A1001 已发货，正在派送中。' }],
            ]);
        }
        return anthropicClient({
            model: process.env.LLM_MODEL || process.env.ANTHROPIC_MODEL,
            baseUrl: process.env.LLM_BASE_URL || process.env.ANTHROPIC_BASE_URL,
            keyEnv: process.env.ANTHROPIC_AUTH_TOKEN ? 'ANTHROPIC_AUTH_TOKEN' : 'LLM_API_KEY',
        });
    };

    return createServer(async (req, res) => {
        const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);

        // React 控制台：SPA 静态托管（/api /health /metrics 优先）
        if (req.method === 'GET' && !url.pathname.startsWith('/api/') && url.pathname !== '/health' && url.pathname !== '/metrics') {
            if (!DIST_DIR) return json(res, 503, { error: '前端未构建：请在 web/ 下执行 npm install && npm run build' });
            const rel = url.pathname === '/' ? 'index.html' : url.pathname.replace(/^\/+/, '');
            const target = path.join(DIST_DIR, rel);
            const inside = path.resolve(target).startsWith(path.resolve(DIST_DIR));
            const file = inside && fs.existsSync(target) && fs.statSync(target).isFile() ? target : path.join(DIST_DIR, 'index.html');
            if (!fs.existsSync(file)) return json(res, 503, { error: '前端产物缺失' });
            res.writeHead(200, { 'content-type': MIME[path.extname(file)] || 'application/octet-stream' });
            return res.end(fs.readFileSync(file));
        }

        if (req.method === 'GET' && url.pathname === '/health') {
            return json(res, 200, {
                ok: true,
                version: '0.1.0',
                mode: process.env.LLM_MODEL || process.env.ANTHROPIC_MODEL ? 'live-available' : 'offline-only',
                runs: EventLog.list(EVENT_DIR).length,
                uptimeSec: Math.round(process.uptime()),
            });
        }

        if (req.method === 'GET' && url.pathname === '/metrics') {
            res.writeHead(200, { 'content-type': 'text/plain; version=0.0.4; charset=utf-8' });
            return res.end(metrics.renderPrometheus());
        }

        if (req.method === 'GET' && url.pathname === '/api/runs') {
            return json(res, 200, { runs: EventLog.list(EVENT_DIR).slice(0, 50) });
        }

        if (req.method === 'GET' && url.pathname.startsWith('/api/runs/')) {
            const id = url.pathname.split('/')[3];
            const events = EventLog.read(EVENT_DIR, id);
            if (!events.length) return json(res, 404, { error: 'run 不存在' });
            return json(res, 200, {
                runId: id,
                trace: createTrace(events),
                report: metrics.runSummary ? metrics.runSummary(events) : undefined,
                events: url.searchParams.get('raw') === '1' ? events : undefined,
            });
        }

        if (req.method === 'POST' && url.pathname === '/api/run') {
            let body;
            try {
                body = JSON.parse(await readBody(req));
            } catch (e) {
                return json(res, e.status || 400, { error: e.message });
            }
            const task = String(body?.task || '').trim();
            const mode = body?.mode === 'live' ? 'live' : 'offline';
            if (!task) return json(res, 400, { error: 'task 必填' });

            // 立刻返回 runId，后台执行——长任务不能占住 HTTP 连接
            const log = new EventLog(EVENT_DIR);
            const runId = log.runId;
            log.append('run_started', { task, mode, agent: 'root', queued: true });

            const agent = createAgent({
                llm: (makeLlm || defaultLlm)(mode),
                tools: buildExampleTools(),
                eventDir: EVENT_DIR,
                system: '你是电商客服助手。需要数据时调用工具；给出结论时必须有工具依据。',
                skillsDir: process.env.SKILLS_DIR || './examples/skills',
                maxTurns: Number(process.env.MAX_TURNS || 8),
            });

            const job = agent
                .run(task, { mode, runId })
                .then((r) => {
                    metrics.observeRun(EventLog.read(EVENT_DIR, r.runId));
                    jobs.set(runId, { status: 'done', runId: r.runId });
                    return r;
                })
                .catch((e) => {
                    jobs.set(runId, { status: 'failed', error: String(e.message || e) });
                });
            jobs.set(runId, { status: 'running', promise: job });

            return json(res, 202, { accepted: true, runId, poll: `/api/runs/${runId}` });
        }

        return json(res, 404, { error: 'not found' });
    });
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
    fs.mkdirSync(EVENT_DIR, { recursive: true });
    const port = Number(process.env.PORT || 8790);
    const server = createApp();
    server.listen(port, () => console.log(`agent-harness listening on :${port}`));
    const shutdown = (s) => {
        console.log(`${s} received, closing`);
        server.close(() => process.exit(0));
        setTimeout(() => process.exit(1), 5000).unref();
    };
    process.on('SIGTERM', () => shutdown('SIGTERM'));
    process.on('SIGINT', () => shutdown('SIGINT'));
}
