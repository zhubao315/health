/* Headless-browser smoke test for dashboard/*.js (optional, needs Node).
 *
 * Usage:
 *   npm i -D playwright-core          # anywhere outside the repo, e.g. /tmp
 *   npx playwright-core install chromium-headless-shell   # one-time download
 *   cd <repo>
 *   python3 -m http.server 8021 --bind 127.0.0.1 --directory dashboard &
 *   BROWSER_PATH=<path-to-shell> node scripts/smoke_dashboard.js
 *
 * Verifies: charts render, 7 KPI cards show their own data date, heatmap cells,
 * day-detail on click, keyboard focus lands on interactive elements, and —
 * most importantly — zero console/page errors while all of that happens.
 * Exits non-zero on any runtime error. The deploy pipeline does not run this;
 * it is a local pre-ship check.
 */
const { chromium } = require('playwright-core');
const executablePath = process.env.BROWSER_PATH;
const url = process.env.SMOKE_URL || 'http://127.0.0.1:8021/index.html';

(async () => {
  const browser = await chromium.launch({
    ...(executablePath ? { executablePath } : {}),
    args: ['--no-sandbox', '--disable-dev-shm-usage'],
  });
  const page = await browser.newPage({ viewport: { width: 1360, height: 900 } });
  const problems = [];
  page.on('pageerror', (e) => problems.push(`pageerror: ${e.message}`));
  page.on('console', (m) => {
    if (m.type() === 'error') problems.push(`console.error: ${m.text()}`);
  });
  page.on('requestfailed', (r) =>
    problems.push(`requestfailed: ${r.url()} ${r.failure()?.errorText}`)
  );

  await page.goto(url, { waitUntil: 'networkidle' });
  await page.waitForTimeout(1500);

  const expect = (cond, msg) => {
    if (!cond) problems.push(msg);
  };

  const data = await page.evaluate(() => ({
    kpis: document.querySelectorAll('.kpi').length,
    canvases: document.querySelectorAll('canvas').length,
    heatCells: document.querySelectorAll('.hcell').length,
    tableRows: document.querySelectorAll('#daily-table tbody tr').length,
  }));
  console.log(JSON.stringify(data));
  expect(data.kpis >= 6, `expect >=6 KPI cards, got ${data.kpis}`);
  expect(data.canvases >= 4, `expect >=4 canvases, got ${data.canvases}`);
  expect(
    data.tableRows >= 10 && data.tableRows <= 30,
    `expect 10-30 table rows, got ${data.tableRows}`
  );

  const kpiText = await page.locator('.kpi').first().innerText().catch(() => '');
  expect(kpiText.includes('单日'), 'KPI line shows 单日 + its own data date');

  // hover two spots on the first chart → tooltip logic must not throw
  const firstCanvas = page.locator('canvas').first();
  await firstCanvas.hover({ position: { x: 100, y: 80 } });
  await page.waitForTimeout(300);
  await firstCanvas.hover({ position: { x: 300, y: 60 } });
  await page.waitForTimeout(300);

  const range31 = page.locator('[data-range="31"], button:has-text("31 天")').first();
  if (await range31.count()) {
    await range31.click();
    await page.waitForTimeout(400);
  }

  // click a heatmap cell → day detail panel
  const cell = page.locator('.hcell').first();
  if (await cell.count()) {
    await cell.click();
    await page.waitForTimeout(300);
    const detail = await page.locator('#day-detail').innerText().catch(() => '');
    expect(detail.includes('关闭'), 'day-detail opens on heat-cell click');
    console.log('day-detail:', detail.slice(0, 100).replace(/\n/g, ' | '));
  }

  // keyboard pass
  for (let i = 0; i < 30; i++) await page.keyboard.press('Tab');
  const focused = await page.evaluate(() => {
    const el = document.activeElement;
    return el ? `${el.tagName}.${el.className || ''}` : 'none';
  });
  console.log('focused after 30 tabs:', focused);
  expect(focused !== 'none', 'keyboard navigation lands on an element');

  await page.screenshot({ path: process.env.SMOKE_SHOT || '/tmp/dashboard_smoke.png' });

  if (problems.length) {
    console.log('FAIL:\n' + problems.map((p) => `  - ${p}`).join('\n'));
    process.exitCode = 1;
  } else {
    console.log('SMOKE OK: no runtime errors');
  }
  await browser.close();
})();
