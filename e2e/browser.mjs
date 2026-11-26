/**
 * 浏览器端到端：发起运行 → 看到轨迹时间线 → 点历史运行能回看。
 */
import fs from 'node:fs';
import path from 'node:path';
import { chromium } from 'playwright';

const OUT = path.resolve('results');
fs.mkdirSync(OUT, { recursive: true });
const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const base = process.env.BASE_URL || 'http://127.0.0.1:8790';
const EXE = ['C:/Users/v-renhan/AppData/Local/ms-playwright/chromium-1255/chrome-win64/chrome.exe'].find((p) => fs.existsSync(p));

const checks = [];
const errors = [];
const check = (n, ok, d = '') => {
    checks.push({ n, ok, d });
    console.log(`${ok ? '✅' : '❌'} ${n}${d ? ` — ${d}` : ''}`);
};

const browser = await chromium.launch({ headless: true, ...(EXE ? { executablePath: EXE } : {}) });
const page = await (await browser.newContext({ viewport: { width: 1440, height: 900 } })).newPage();
page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
page.on('pageerror', (e) => errors.push(String(e)));

try {
    const r = await page.goto(base + '/', { waitUntil: 'networkidle', timeout: 30_000 });
    check('页面可打开', r?.status() === 200, `HTTP ${r?.status()}`);
    check('React 已挂载', (await page.locator('#root').count()) === 1);
    check('运行列表区块渲染', (await page.locator('[data-testid="runs"]').count()) === 1);

    // 发起一次运行（离线脚本模型）
    await page.fill('[aria-label="任务"]', '我的订单 A1001 到哪了？');
    await page.click('[data-testid="run"]');
    await page.waitForSelector('[data-testid="trace"]', { timeout: 60_000 });
    const items = await page.locator('[data-testid="trace"] li').count();
    check('轨迹时间线渲染', items > 0, `${items} 个事件`);

    const text = await page.locator('[data-testid="trace"]').innerText();
    check('轨迹含模型轮次', /模型/.test(text), '');
    check('轨迹含工具调用', /工具/.test(text), '');
    check('轨迹含技能加载', /技能/.test(text), '');
    check('轨迹含结束', /结束/.test(text), '');

    // 列表里能点开历史运行
    const rows = await page.locator('[data-testid="runs"] tr').count();
    check('运行列表有记录', rows >= 1, `${rows} 行`);

    await page.screenshot({ path: path.join(OUT, `browser-${stamp}.png`), fullPage: true });
    check('无控制台错误', errors.length === 0, errors.slice(0, 2).join(' | '));
} catch (e) {
    check('执行过程', false, String(e.message).slice(0, 160));
    await page.screenshot({ path: path.join(OUT, `browser-${stamp}-fail.png`), fullPage: true }).catch(() => {});
} finally {
    await browser.close();
}

const failed = checks.filter((c) => !c.ok).length;
fs.writeFileSync(path.join(OUT, `browser-${stamp}.json`), JSON.stringify({ base, checks, errors }, null, 2));
console.log(`\n${checks.length - failed}/${checks.length} 通过`);
process.exit(failed ? 1 : 0);
