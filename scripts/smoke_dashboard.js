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

  // --- correlation lag switch must refresh the quantile panel as well ------
  // The bucket panel states the lag it was computed with; switching the lag
  // only redrew the scatter plot before, so the two halves disagreed.
  const lag = page.locator('#corr-lag');
  if (await lag.count()) {
    const before = await page.locator('#corr-buckets .hint').innerText().catch(() => '');
    await lag.selectOption('2');
    await page.waitForTimeout(400);
    const after = await page.locator('#corr-buckets .hint').innerText().catch(() => '');
    console.log('corr-buckets hint:', before.replace(/\n/g, ' | '), '->', after.replace(/\n/g, ' | '));
    expect(after.includes('滞后 2 天'), `bucket panel lag label follows the lag switch (got "${after}")`);
    expect(after !== before, 'bucket panel is re-rendered when the lag changes');
    await lag.selectOption('1');
    await page.waitForTimeout(200);
  }

  // --- custom range must drive the correlation window as well -------------
  // The scatter plot and the quantile panel used to ignore the custom
  // start/end range and kept filtering by the preset day count.
  const heatDates = await page.evaluate(() =>
    [...document.querySelectorAll('.hcell')].map((c) => c.dataset.date).filter(Boolean)
  );
  if (heatDates.length > 40) {
    const end = heatDates[heatDates.length - 1];
    const startDate = new Date(end + 'T00:00:00Z');
    startDate.setUTCDate(startDate.getUTCDate() - 29);
    const start = startDate.toISOString().slice(0, 10);
    const corrPoints = () =>
      page.evaluate(() => {
        const chart = window.Chart && Chart.getChart('corrChart');
        return chart ? chart.data.datasets[0].data.length : -1;
      });
    const before = await corrPoints();
    await page.locator('#custom-toggle').click();
    await page.locator('#range-start').fill(start);
    await page.locator('#range-end').fill(end);
    await page.locator('#range-apply').click();
    await page.waitForTimeout(700);
    const after = await corrPoints();
    console.log(`corr points: preset=${before} custom(${start}..${end})=${after}`);
    expect(
      after >= 0 && after < before,
      `custom range narrows the correlation window (${before} -> ${after})`
    );
    // restore the preset view for the remaining checks
    await page.locator('#range button[data-range="90"]').click();
    await page.waitForTimeout(400);
  }

  // --- body module keeps its own timeline ---------------------------------
  // Default view is "all history", so the card must not be empty even though
  // the top bar starts on the last 90 days.
  const bodyCards = await page.locator('#body-metrics .metric-card').count();
  expect(bodyCards > 0, `expect body metric cards on first paint, got ${bodyCards}`);
  const bodyHint = await page.locator('#body-hint').innerText().catch(() => '');
  console.log('body hint:', bodyHint.replace(/\n/g, ' | '));
  expect(bodyHint.includes('独立时间轴'), 'body card states that it has its own time axis');

  // switching the body range to "follow the top bar" must not crash and has
  // to re-label the card
  const bodyFollow = page.locator('#body-range button[data-body-range="follow"]');
  if (await bodyFollow.count()) {
    await bodyFollow.click();
    await page.waitForTimeout(400);
    const followHint = await page.locator('#body-hint').innerText().catch(() => '');
    console.log('body hint (follow):', followHint.replace(/\n/g, ' | '));
    expect(followHint.includes('跟随顶栏'), 'body range switch updates the card hint');
    await page.locator('#body-range button[data-body-range="all"]').click();
    await page.waitForTimeout(300);
  }

  // --- the recent activities link to the sport sites ----------------------
  // The activity rows are the bridge between the health dashboard and the
  // three sport sites: a sport name jumps to that site's view of the day.
  const activities = await page.evaluate(() => {
    const rows = document.querySelectorAll('#activities tbody tr');
    const links = [...document.querySelectorAll('#activities a.sport-link')];
    return {
      rows: rows.length,
      links: links.length,
      hrefs: links.slice(0, 3).map((a) => a.getAttribute('href')),
    };
  });
  expect(activities.rows > 0, `the recent activities table has rows (got ${activities.rows})`);
  expect(
    activities.links === activities.rows,
    `every activity row links to its sport site (${activities.links}/${activities.rows})`
  );
  expect(
    activities.hrefs.every((href) =>
      /^https:\/\/zhubao315\.github\.io\/(running|cycling|hiking)\/\?date=\d{4}-\d{2}-\d{2}$/.test(
        href || ''
      )
    ),
    `the activity links address the right site and day (${activities.hrefs.join(' ')})`
  );

  // --- legacy engine compatibility pass ----------------------------------
  // Older mobile WebViews and headless renderers ship without
  // Array.prototype.at (ES2022) and Canvas2D roundRect. Removing both before
  // the page scripts run proves the dashboard no longer depends on them.
  const legacy = await browser.newPage({ viewport: { width: 1360, height: 900 } });
  await legacy.addInitScript(() => {
    try { delete Array.prototype.at; } catch (e) { /* ignore */ }
    try {
      if (window.CanvasRenderingContext2D) delete CanvasRenderingContext2D.prototype.roundRect;
    } catch (e) { /* ignore */ }
  });
  const legacyProblems = [];
  legacy.on('pageerror', (e) => legacyProblems.push(`pageerror: ${e.message}`));
  legacy.on('console', (m) => {
    if (m.type() === 'error') legacyProblems.push(`console.error: ${m.text()}`);
  });
  await legacy.goto(url, { waitUntil: 'networkidle' });
  await legacy.waitForTimeout(1500);
  const legacyState = await legacy.evaluate(() => ({
    at: typeof Array.prototype.at,
    kpis: document.querySelectorAll('.kpi').length,
    label: document.querySelector('#kpis .kpi .label')?.textContent || '',
    bodyCards: document.querySelectorAll('#body-metrics .metric-card').length,
  }));
  console.log('legacy engine state:', JSON.stringify(legacyState));
  expect(legacyState.at === 'undefined', 'legacy pass really removed Array.prototype.at');
  expect(
    legacyProblems.length === 0,
    `legacy engine pass raised errors: ${legacyProblems.join(' | ')}`
  );
  expect(legacyState.kpis >= 6, `legacy engine pass still renders KPIs, got ${legacyState.kpis}`);
  expect(
    !legacyState.label.includes('失败'),
    `legacy engine pass must not show a fatal banner (got "${legacyState.label}")`
  );
  expect(legacyState.bodyCards > 0, 'legacy engine pass still renders the body card');
  await legacy.close();

  await page.screenshot({ path: process.env.SMOKE_SHOT || '/tmp/dashboard_smoke.png' });

  if (problems.length) {
    console.log('FAIL:\n' + problems.map((p) => `  - ${p}`).join('\n'));
    process.exitCode = 1;
  } else {
    console.log('SMOKE OK: no runtime errors');
  }
  await browser.close();
})();
