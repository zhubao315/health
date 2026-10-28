/* 个人健康面板 —— 数据驱动（dashboard/data.json + data_quality.json）
 *
 * 原则：
 * - 缺失值显示为「缺失」，绝不当 0。
 * - KPI 区分单日 / 7 天 / 28 天基线 / 当前选定范围，各自的数据日期可见。
 * - 全部图表共享同一时间范围（hero 的 range 选择器）。
 * - 状态文案明确：加载中 / 无数据 / 同步过期 / 加载失败。
 */

'use strict';

// ------------------------------------------------------- build / cache guard

// Stamped together with index.html by the deploy workflow (workflow replaces
// both "__BUILD__" placeholders with the same content hash). A browser that
// mixes a cached HTML with a fresh app.js — or the reverse — would otherwise
// hit `Cannot set properties of null (setting 'innerHTML')` and show an empty
// page. Detect that combination early and ask for a hard refresh instead.
const ASSET_BUILD = '__BUILD_HASH__';

const isStaleBuild = () =>
  typeof window.__ASSET_BUILD__ !== 'string' ||
  window.__ASSET_BUILD__ !== ASSET_BUILD;

const showTopBanner = (html) => {
  const bar = document.createElement('div');
  bar.setAttribute('role', 'alert');
  bar.style.cssText =
    'position:sticky;top:0;z-index:99999;padding:14px 18px;background:#7f1d1d;' +
    'color:#fff;font:14px/1.65 system-ui,-apple-system,sans-serif;text-align:center;';
  bar.innerHTML = html;
  document.body.prepend(bar);
};

const showStaleBuildNotice = () => {
  showTopBanner(
    '页面资源版本不一致（浏览器缓存了旧文件），数据因此无法加载。<br>' +
      '请<b>强制刷新</b>：桌面 <b>Ctrl/Cmd + Shift + R</b>；手机在微信中「刷新」或重新打开链接。'
  );
};

// ------------------------------------------------------------------ helpers

const C = {
  accent: '#22d3ee',
  accent2: '#0ea5e9',
  red: '#fb7185',
  amber: '#fbbf24',
  slate: '#64748b',
  green: '#34d399',
  grid: '#1a2029',
  text: '#e6eaf0',
  muted: '#8b95a5',
  // aggregation lines stay neutral; series are separated by dash pattern too
  line: '#e2e8f0',
  lineDim: '#7c8795',
};

const chartDefaults = () => {
  Chart.defaults.color = C.muted;
  Chart.defaults.borderColor = C.grid;
  Chart.defaults.font.family =
    "'Fira Sans', -apple-system, BlinkMacSystemFont, 'PingFang SC', sans-serif";
  Chart.defaults.font.size = 11;
  Chart.defaults.plugins.tooltip.backgroundColor = '#0d1116';
  Chart.defaults.plugins.tooltip.borderColor = '#2b333d';
  Chart.defaults.plugins.tooltip.borderWidth = 1;
  Chart.defaults.plugins.tooltip.titleColor = C.text;
  Chart.defaults.plugins.tooltip.bodyColor = C.muted;
  Chart.defaults.plugins.tooltip.cornerRadius = 6;
  Chart.defaults.plugins.tooltip.padding = 10;
  Chart.defaults.plugins.tooltip.displayColors = false;
  if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
    Chart.defaults.animation = false;
  }
};

const charts = {};
const makeChart = (id, config) => {
  if (charts[id]) charts[id].destroy();
  const canvas = document.getElementById(id);
  charts[id] = new Chart(canvas, config);
  return charts[id];
};

const hmin = (m) => {
  if (m === null || m === undefined) return '缺失';
  const h = Math.floor(m / 60);
  const mm = Math.round(m % 60);
  return h ? `${h}h ${String(mm).padStart(2, '0')}m` : `${mm}m`;
};

const num = (v, digits = 0) =>
  v === null || v === undefined
    ? '缺失'
    : Number(v).toLocaleString('en-US', {
        minimumFractionDigits: digits,
        maximumFractionDigits: digits,
      });

const fmtPct = (v) => (v === null || v === undefined ? '—' : `${(v * 100).toFixed(1)}%`);

const beijing = (iso) => {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString('zh-CN', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  });
};

const addDays = (iso, delta) => {
  const d = new Date(iso + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + delta);
  return d.toISOString().slice(0, 10);
};

// ------------------------------------------------------------------- state

const state = {
  range: 90, // 30 / 90 / 365 / 0(全部)
  corrKey: 0,
  corrLag: 1,
  heat: 'sleep_total_min',
  dailyExpanded: false,
  // rows rendered in the daily table: 30 initially, +200 per "load more".
  // Keeps DOM small on phones even when "全部" (1000+) is selected.
  dailyLimit: 30,
  data: null,
  quality: null,
  rangeRows: [],
};

const METRICS = [
  { key: 'sleep_total_min', label: '睡眠时长', unit: 'min', fmt: hmin, wake: true },
  { key: 'hrv_avg', label: '夜间 HRV', unit: 'ms', fmt: (v) => `${num(v)} ms`, wake: true },
  { key: 'rhr', label: '静息心率', unit: 'bpm', fmt: (v) => `${num(v)} bpm`, wake: false },
  { key: 'stress_avg', label: '平均压力', unit: '分', fmt: (v) => num(v), wake: false },
  { key: 'load_short', label: '短期负荷', unit: '', fmt: (v) => num(v), wake: false },
  { key: 'steps', label: '步数', unit: '步', fmt: (v) => num(v), wake: false },
  { key: 'sleep_score', label: '睡眠分', unit: '分', fmt: (v) => num(v), wake: true },
];

const metric = (key) => METRICS.find((m) => m.key === key);

const validAvg = (values) => {
  const vals = values.filter((v) => v !== null && v !== undefined);
  if (!vals.length) return null;
  const sum = vals.reduce((a, b) => a + b, 0);
  return Math.round((sum / vals.length) * 10) / 10;
};

const rangeAvg = (key) => validAvg(state.rangeRows.map((r) => r[key]));

// dependent series index by date directly (series arrays align with data.daily)
const seriesAt = (skey, field, date) => {
  const s = state.data?.series?.[skey];
  if (!s || !s[field]) return null;
  const idx = state.data.daily.findIndex((r) => r.date === date);
  return idx >= 0 ? s[field][idx] : null;
};

// ------------------------------------------------------------- status strip

const setStatus = (kind, text) => {
  const strip = document.getElementById('data-status');
  const icon = document.getElementById('status-icon');
  const label = document.getElementById('status-text');
  if (!strip || !icon || !label) return; // stale HTML without status strip
  strip.hidden = !kind;
  // typographic marks, not emoji: emoji vary per platform and can't be themed
  icon.textContent =
    kind === 'ok' ? '●' : kind === 'warn' ? '▲' : kind === 'err' ? '■' : '○';
  strip.classList.remove('ok', 'warn', 'err');
  if (kind) strip.classList.add(kind);
  label.textContent = text;
};

const renderStatus = () => {
  const q = state.quality;
  const d = state.data;
  if (!d) return;
  const latest = q?.latest_data_date || d.coverage?.daily_health?.end;
  const badge = document.getElementById('badge');
  const gen = beijing(d.generated_at);
  if (!q) {
    setStatus('warn', `数据读到了（最新 ${latest || '未知'}），但 data_quality.json 不可用`);
    badge.innerHTML = `<span class="dot" aria-hidden="true"></span> 最新数据 ${latest || '—'}`;
    return;
  }
  if (q.sync_status === 'empty') {
    setStatus('err', '暂无数据：同步任务可能尚未运行过，查看同步记录。');
  } else if (q.sync_status === 'stale') {
    setStatus(
      'warn',
      `同步已过期：最新数据 ${latest}（${q.days_since_latest} 天前）。今天08:00（北京时间）例行运行；若连续过期请查看同步记录。`
    );
  } else {
    setStatus(
      'ok',
      `同步正常 · 最新数据 ${latest} · 生成于 ${gen}（北京时间）`
    );
  }
  badge.innerHTML =
    q.sync_status === 'stale'
      ? `<span class="dot stale" aria-hidden="true"></span> 数据 ${q.days_since_latest} 天前更新`
      : `<span class="dot" aria-hidden="true"></span> 最新数据 ${latest || '—'}`;
  const stamp = d.generated_at ? `生成于 ${gen}（北京时间）` : '';
  document.getElementById('generated').textContent = stamp;
};

// -------------------------------------------------------------------- KPIs

const direction = (delta, tolPct = 0.05) => {
  if (delta === null) return { glyph: '·', text: '与基线比样本不足', cls: '' };
  if (Math.abs(delta) < tolPct) return { glyph: '→', text: '持平', cls: 'flat' };
  if (delta > 0) return { glyph: '▲', text: '偏高', cls: 'up' };
  return { glyph: '▼', text: '偏低', cls: 'down' };
};

const buildKpis = () => {
  const d = state.data;
  const latestDate =
    d.coverage?.daily_health?.end || state.rangeRows.at(-1)?.date || '';
  const cards = METRICS.map((m) => {
    const latest = d.latest[m.key] || {};
    const v7 = seriesAt(m.key, 'mean_7d', latest.date || latestDate);
    const v28 = seriesAt(m.key, 'mean_28d', latest.date || latestDate);
    const d28 = v28 !== null && latest.value !== null ? latest.value - v28 : null;
    const dir = m.key === 'sleep_score' ? null : direction(d28, (v28 || 1) * 0.05);
    const inRange = validAvg(state.rangeRows.map((r) => r[m.key]));
    const rangeNote =
      state.range >= 365
        ? `全部均值 ${m.fmt(inRange)}`
        : `${state.range} 天均值 ${m.fmt(inRange)}`;
    return `
      <article class="kpi">
        <span class="value">${m.fmt(latest.value)}</span>
        <span class="label">${m.label}${m.key === 'steps' ? ` · ${rangeNote}` : ''}</span>
        <span class="kpi-line"><b>单日</b>（${latest.date || latestDate}）</span>
        <span class="kpi-line">7 天均值 ${m.fmt(v7)} · 28 天基线 ${m.fmt(v28)}</span>
        ${
          dir
            ? `<span class="kpi-line dir ${dir.cls}">${dir.glyph} ${dir.text} ${d28 === null ? '' : num(Math.abs(d28), 1) + ' ' + m.unit}</span>`
            : ''
        }
      </article>`;
  });
  const box = document.getElementById('kpis');
  box.innerHTML = cards.join('');
  box.removeAttribute('aria-busy');
};

// ------------------------------------------------------------------ charts

const filterRows = () => {
  const all = state.data.daily;
  return state.range > 0 ? all.slice(-state.range) : all;
};

const shortDate = (r) => r.date.slice(5);

const lineDataset = (label, accessor, color, extra = {}) => ({
  label,
  data: state.rangeRows.map(accessor),
  borderColor: color,
  backgroundColor: color,
  borderWidth: 1.6,
  pointRadius: 0,
  pointHoverRadius: 3,
  tension: 0.15,
  spanGaps: false,
  ...extra,
});

const baseScales = (unit, stacked = false) => ({
  x: {
    grid: { display: false },
    ticks: { maxRotation: 0, autoSkip: true, maxTicksLimit: 11 },
    stacked,
  },
  y: {
    grid: { color: C.grid },
    ticks: { maxTicksLimit: 6 },
    stacked,
    title: { display: !!unit, text: unit, color: C.muted },
  },
});

const chartOptions = (unit, extra = {}) => ({
  responsive: true,
  maintainAspectRatio: false,
  animation: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? false : undefined,
  interaction: { mode: 'index', intersect: false },
  plugins: {
    legend: { display: false },
    tooltip: {
      callbacks: {
        title: (items) =>
          items.length ? (state.rangeRows[items[0].dataIndex]?.date ?? '') : '',
        afterBody: (items) => {
          const row = state.rangeRows[items[0]?.dataIndex];
          if (!row || row.stage_completeness === undefined) return [];
          return row.stage_completeness < 1
            ? `（分期完整性 ${Math.round(row.stage_completeness * 100)}%，缺失分期按缺失显示）`
            : [];
        },
      },
    },
  },
  scales: baseScales(unit),
  ...extra,
});

const withLegend = (opts, show = true) => ({
  ...opts,
  plugins: {
    ...(opts.plugins || {}),
    legend: {
      display: show,
      position: 'bottom',
      labels: { boxWidth: 10, usePointStyle: true, padding: 12 },
    },
  },
});

// ------------------------------------------------- body composition (scale)
const bodyLatest = (s) => {
  for (let i = s.values.length - 1; i >= 0; i--) {
    if (s.values[i] !== null && s.values[i] !== undefined) {
      return { value: s.values[i], date: s.dates[i], i };
    }
  }
  return null;
};

const renderBodyKpis = () => {
  const box = document.getElementById('body-kpis');
  if (!box) return;
  const parts = [];
  for (const [key, label, unit, digits] of [
    ['weight_kg', '体重', 'kg', 1],
    ['body_fat_pct', '体脂率', '%', 1],
    ['visceral_fat', '内脏脂肪', '级', 0],
  ]) {
    const series = state.data.series[key];
    const latest = series?.dates ? bodyLatest(series) : null;
    let value = latest?.value;
    let date = latest?.date;
    if (key === 'visceral_fat') {
      const row = [...(state.data.body || [])].reverse().find((r) => r.visceral_fat != null);
      value = row?.visceral_fat;
      date = row?.date;
    }
    if (value === null || value === undefined) continue;
    const mean7 = series?.mean_7d?.[latest?.i] ?? null;
    const delta = mean7 !== null ? value - mean7 : null;
    parts.push(`
      <span class="item">
        <span class="value">${num(value, digits)}</span>
        <span class="label">${label} ${unit} · ${date || '—'}</span>
        ${delta === null ? '' : `<span class="delta">较近 7 次 ${delta > 0 ? '+' : ''}${num(delta, 1)}</span>`}
      </span>`);
  }
  const last = state.data.body?.[state.data.body.length - 1];
  if (last) {
    const days = Math.round(
      (Date.now() - new Date(last.date + 'T00:00:00').getTime()) / 86400000
    );
    if (days >= 0 && days <= 400) {
      parts.push(
        `<span class="item"><span class="label">距上次称重 ${days === 0 ? '今天' : days + ' 天'}</span></span>`
      );
    }
  }
  box.innerHTML = parts.join('');
  renderBodyYears();
};

const renderBodyYears = () => {
  const box = document.getElementById('body-years');
  const rows = state.data.body || [];
  if (!box || !rows.length) return;
  const byYear = new Map();
  for (const r of rows) {
    const y = r.date.slice(0, 4);
    const e = byYear.get(y) || { n: 0, w: [], f: [] };
    e.n += 1;
    if (r.weight_kg != null) e.w.push(r.weight_kg);
    if (r.body_fat_pct != null) e.f.push(r.body_fat_pct);
    byYear.set(y, e);
  }
  const avg = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);
  const body = [...byYear.entries()]
    .sort((a, b) => b[0].localeCompare(a[0]))
    .map(([y, e]) => {
      const w = avg(e.w);
      const f = avg(e.f);
      return `<tr><td>${y}</td><td class="num">${e.n}</td><td class="num">${w == null ? '—' : num(w, 1)}</td><td class="num">${f == null ? '—' : num(f, 1)}</td></tr>`;
    })
    .join('');
  box.innerHTML = `
    <table class="coverage table-inline body-year-table">
      <thead><tr><th>年份</th><th class="num">称重次数</th><th class="num">体重均值 kg</th><th class="num">体脂均值 %</th></tr></thead>
      <tbody>${body}</tbody>
      <caption>只统计当年实际称重记录；「—」表示当年没有体脂数据（只测了体重）</caption>
    </table>`;
};

const renderBodyCharts = () => {
  const w = state.data.series?.weight_kg;
  const f = state.data.series?.body_fat_pct;
  if (!w?.dates?.length) return;
  renderBodyKpis();
  makeChart(
    'weightChart',
    withLegend({
      type: 'line',
      data: {
        labels: w.dates,
        datasets: [
          lineDataset('体重', () => null, C.accent, {
            data: w.values,
            pointRadius: 2,
            pointHoverRadius: 4,
            borderWidth: 1.4,
          }),
          lineDataset('近 7 次均值', () => null, C.line, {
            data: w.mean_7d,
            borderWidth: 1.2,
          }),
        ],
      },
      options: withLegend(chartOptions('kg'), true),
    })
  );
  makeChart(
    'bodyFatChart',
    withLegend({
      type: 'line',
      data: {
        labels: f.dates,
        datasets: [
          lineDataset('体脂率', () => null, C.amber, {
            data: f.values,
            pointRadius: 2,
            pointHoverRadius: 4,
            borderWidth: 1.4,
          }),
          lineDataset('近 7 次均值', () => null, C.line, {
            data: f.mean_7d,
            borderWidth: 1.2,
          }),
        ],
      },
      options: withLegend(chartOptions('%'), true),
    })
  );
};

const renderCharts = () => {
  state.rangeRows = filterRows();
  buildKpis();
  renderSleepChart();
  renderHrvChart();
  renderRhrChart();
  renderStressChart();
  renderStepsChart();
  renderLoadCharts();
  renderBodyCharts();
  renderCorrChart();
  renderCorrStats();
  renderHeatmap();
  renderDayDetail();
  renderDailyTable();
  renderCoverage();
  renderStatus();
};

const renderSleepChart = () => {
  const rows = state.rangeRows;
  makeChart(
    'sleepChart',
    withLegend({
      type: 'bar',
      data: {
        labels: rows.map(shortDate),
        datasets: [
          { label: '深睡', data: rows.map((r) => r.deep), backgroundColor: '#0e7490', borderColor: '#0e7490', stack: 's' },
          { label: '浅睡', data: rows.map((r) => r.light), backgroundColor: 'rgba(34,211,238,0.65)', borderColor: C.accent, stack: 's' },
          { label: 'REM', data: rows.map((r) => r.rem), backgroundColor: 'rgba(125,211,252,0.45)', borderColor: '#7dd3fc', stack: 's' },
          { label: '清醒', data: rows.map((r) => r.awake), backgroundColor: 'rgba(100,116,139,0.45)', borderColor: C.slate, stack: 's' },
          {
            label: '总时长（线）',
            data: rows.map((r) => r.sleep_total_min),
            type: 'line',
            borderColor: C.line,
            backgroundColor: C.line,
            borderWidth: 1.2,
            borderDash: [5, 4],
            pointRadius: 0,
            tension: 0.15,
          },
        ],
      },
      options: withLegend(
        chartOptions('分钟', {
          scales: baseScales('分钟', true),
        }),
        true
      ),
    })
  );
};

// series 数组长度 === data.daily 全长度；range 始终 tail-slice ⇒ 全局 index 有固定偏移
const toGlobal = (i) => state.data.daily.length - state.rangeRows.length + i;

const renderHrvChart = () => {
  const s = state.data.series.hrv;
  makeChart(
    'hrvChart',
    withLegend({
      type: 'line',
      data: {
        labels: state.rangeRows.map(shortDate),
        datasets: [
          lineDataset('单日 HRV', (r) => r.hrv_avg, C.accent, {
            fill: true,
            backgroundColor: 'rgba(34,211,238,0.10)',
          }),
          lineDataset('7 天均值', () => null, '#e2e8f0', {
            borderWidth: 1.4,
            data: state.rangeRows.map((_, i) => s.mean_7d[toGlobal(i)]),
          }),
          lineDataset('28 天基线', () => null, C.lineDim, {
            borderDash: [6, 4],
            borderWidth: 1.2,
            data: state.rangeRows.map((_, i) => s.mean_28d[toGlobal(i)]),
          }),
          lineDataset('设备基线', () => null, C.slate, {
            borderDash: [2, 3],
            borderWidth: 1,
            data: state.rangeRows.map((_, i) => s.device_baseline[toGlobal(i)]),
          }),
        ],
      },
      options: withLegend(chartOptions('ms')),
    })
  );
};

const renderRhrChart = () => {
  const s = state.data.series.rhr;
  makeChart(
    'rhrChart',
    withLegend({
      type: 'line',
      data: {
        labels: state.rangeRows.map(shortDate),
        datasets: [
          lineDataset('单日', (r) => r.rhr, C.accent, {
            fill: true,
            backgroundColor: 'rgba(34,211,238,0.08)',
          }),
          {
            label: '7 天均值',
            data: state.rangeRows.map((_, i) => s.mean_7d[toGlobal(i)]),
            borderColor: '#e2e8f0',
            backgroundColor: '#e2e8f0',
            borderWidth: 1.4,
            pointRadius: 0,
            tension: 0.25,
          },
        ],
      },
      options: withLegend(chartOptions('bpm')),
    })
  );
};

const renderStressChart = () => {
  const s = state.data.series.stress_avg;
  makeChart(
    'stressChart',
    withLegend({
      type: 'line',
      data: {
        labels: state.rangeRows.map(shortDate),
        datasets: [
          lineDataset('平均压力', (r) => r.stress_avg, C.accent, {
            fill: true,
            backgroundColor: 'rgba(34,211,238,0.08)',
          }),
          {
            label: '7 天均值',
            data: state.rangeRows.map((_, i) => s.mean_7d[toGlobal(i)]),
            borderColor: '#e2e8f0',
            backgroundColor: '#e2e8f0',
            borderWidth: 1.4,
            pointRadius: 0,
            tension: 0.25,
          },
        ],
      },
      options: withLegend(chartOptions('分')),
    })
  );
};

const renderStepsChart = () => {
  makeChart(
    'stepsChart',
    withLegend({
      type: 'bar',
      data: {
        labels: state.rangeRows.map(shortDate),
        datasets: [
          {
            label: '步数',
            data: state.rangeRows.map((r) => r.steps),
            backgroundColor: 'rgba(56,189,248,0.55)',
            borderRadius: 3,
          },
        ],
      },
      options: withLegend(chartOptions('步')),
    })
  );
};

const renderLoadCharts = () => {
  makeChart(
    'loadChart',
    withLegend({
      type: 'line',
      data: {
        labels: state.rangeRows.map(shortDate),
        datasets: [
          lineDataset('短期负荷（7 天）', (r) => r.load_short, C.accent),
          lineDataset('长期负荷（28 天）', (r) => r.load_long, C.accent2, {
            borderDash: [5, 3],
          }),
        ],
      },
      options: withLegend(chartOptions('负荷')),
    })
  );
  const ratio = makeChart(
    'loadRatioChart',
    withLegend({
      type: 'line',
      data: {
        labels: state.rangeRows.map(shortDate),
        datasets: [
          {
            label: '负荷比',
            data: state.rangeRows.map((r) => r.load_ratio),
            borderColor: C.amber,
            backgroundColor: C.amber,
            borderWidth: 1.6,
            pointRadius: 0,
            tension: 0.25,
          },
          {
            label: '参考线 1.0',
            data: state.rangeRows.map(() => 1),
            borderColor: 'rgba(148,163,184,0.5)',
            borderWidth: 1,
            borderDash: [4, 4],
            pointRadius: 0,
          },
        ],
      },
      options: withLegend(chartOptions('负荷比')),
    })
  );
  syncTooltips(charts.loadChart, ratio);
};

const syncTooltips = (a, b) => {
  if (!a || !b) return;
  const link = (from, to) => {
    from.options.onHover = (evt, elements) => {
      const index = elements[0]?.index ?? null;
      if (index === null || index === undefined) return;
      const act = [{ datasetIndex: 0, index }];
      to.tooltip.setActiveElements(act, { x: 0, y: 0 });
      to.update('none');
    };
    from.options.onLeave = () => {
      to.tooltip.setActiveElements([], { x: 0, y: 0 });
      to.update('none');
    };
  };
  link(a, b);
  link(b, a);
};

// -------------------------------------------------------- correlation tools

const CORR_DEFS = [
  { key: 'sleep-hrv', label: '睡眠时长 → 次日 HRV', x: 'sleep_total_min', y: 'hrv_avg', xu: 'min', yu: 'ms' },
  { key: 'load-rhr', label: '短期负荷 → 次日静息心率', x: 'load_short', y: 'rhr', xu: '负荷', yu: 'bpm' },
  { key: 'stress-sleep', label: '压力 → 当晚睡眠（次日记录）', x: 'stress_avg', y: 'sleep_total_min', xu: '分', yu: 'min' },
  { key: 'steps-sleep', label: '步数 → 当晚睡眠（次日记录）', x: 'steps', y: 'sleep_total_min', xu: '步', yu: 'min' },
  { key: 'sleep-rhr', label: '睡眠时长 → 次日静息心率', x: 'sleep_total_min', y: 'rhr', xu: 'min', yu: 'bpm' },
];

const corrPairs = () => {
  const def = CORR_DEFS[state.corrKey];
  const all = state.data.daily;
  const by = new Map(all.map((r) => [r.date, r]));
  const pairs = [];
  for (const r of all) {
    const target = by.get(addDays(r.date, state.corrLag));
    if (!target) continue;
    const x = r[def.x];
    const y = target[def.y];
    if (x === null || x === undefined || y === null || y === undefined) continue;
    const inRange = !state.range || all.indexOf(r) >= all.length - state.range;
    if (inRange) pairs.push({ x, y, date: r.date });
  }
  return { def, pairs };
};

const pearsonJs = (pairs) => {
  const n = pairs.length;
  if (n < 8) return { r: null, n, lo: null, hi: null };
  const mx = pairs.reduce((a, p) => a + p.x, 0) / n;
  const my = pairs.reduce((a, p) => a + p.y, 0) / n;
  let cov = 0, vx = 0, vy = 0;
  for (const p of pairs) {
    cov += (p.x - mx) * (p.y - my);
    vx += (p.x - mx) ** 2;
    vy += (p.y - my) ** 2;
  }
  if (vx <= 0 || vy <= 0) return { r: null, n, lo: null, hi: null };
  const r = Math.max(-1, Math.min(1, cov / Math.sqrt(vx * vy)));
  if (n < 4) return { r, n, lo: null, hi: null };
  const z = Math.log((1 + r) / (1 - r)) / 2;
  const se = 1 / Math.sqrt(n - 3);
  const unz = (v) => (Math.exp(2 * v) - 1) / (Math.exp(2 * v) + 1);
  return { r, n, lo: unz(z - 1.96 * se), hi: unz(z + 1.96 * se) };
};

const renderCorrChart = () => {
  const { def, pairs } = corrPairs();
  const st = pearsonJs(pairs);
  makeChart('corrChart', {
    type: 'scatter',
    data: {
      datasets: [
        {
          label: def.label,
          data: pairs.map((p) => ({ x: p.x, y: p.y, date: p.date })),
          borderColor: C.accent,
          backgroundColor: 'rgba(34,211,238,0.35)',
          pointRadius: 3,
          pointHoverRadius: 5,
        },
        ...(st.r !== null && pairs.length >= 2
          ? [
              {
                label: `线性拟合 r=${st.r.toFixed(2)}`,
                type: 'line',
                data: (() => {
                  const xs = pairs.map((p) => p.x);
                  const ys = pairs.map((p) => p.y);
                  const mx = xs.reduce((a, b) => a + b, 0) / xs.length;
                  const my = ys.reduce((a, b) => a + b, 0) / ys.length;
                  const b =
                    pairs.reduce((a, p) => a + (p.x - mx) * (p.y - my), 0) /
                    pairs.reduce((a, p) => a + (p.x - mx) ** 2, 0);
                  const a = my - b * mx;
                  const xmin = Math.min(...xs), xmax = Math.max(...xs);
                  return [
                    { x: xmin, y: a + b * xmin },
                    { x: xmax, y: a + b * xmax },
                  ];
                })(),
                borderColor: 'rgba(226,232,240,0.6)',
                borderWidth: 1.4,
                borderDash: [6, 4],
                pointRadius: 0,
              },
            ]
          : []),
      ],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: { display: false },
        tooltip: {
          callbacks: {
            title: (items) => (items[0]?.raw?.date ? `日期 ${items[0].raw.date}` : ''),
            label: (ctx) =>
              ctx.datasetIndex === 0
                ? `${def.xu} ${num(ctx.parsed.x)} → ${def.yu} ${num(ctx.parsed.y)}`
                : '',
          },
        },
      },
      scales: {
        x: {
          type: 'linear',
          title: { display: true, text: `${def.label.split('→')[0].trim()}（${def.xu}）`, color: C.muted },
          grid: { color: C.grid },
        },
        y: {
          title: { display: true, text: `${def.label.split('→')[1].trim()}（${def.yu}）`, color: C.muted },
          grid: { color: C.grid },
        },
      },
    },
  });
};

const renderCorrStats = () => {
  const rows = CORR_DEFS.map((def, key) => {
    // 用全部数据算（与 data.json 的基线一致），当前视图的散点仍受 range 控制
    const all = state.data.daily;
    const by = new Map(all.map((r) => [r.date, r]));
    const pts = [];
    for (const r of all) {
      const t = by.get(addDays(r.date, 1));
      if (t && r[def.x] != null && t[def.y] != null) pts.push({ x: r[def.x], y: t[def.y] });
    }
    const s = pearsonJs(pts);
    const server = state.data.correlations.find((c) => c.label === def.label);
    const r = s.r === null ? '—' : s.r.toFixed(3);
    const ci =
      s.lo === null
        ? '样本不足'
        : `[${s.lo.toFixed(2)}, ${(s.hi ?? 0).toFixed(2)}]`;
    return `<tr${key === state.corrKey ? ' class="active"' : ''}>
      <td>${def.label}</td><td class="num">${r}</td>
      <td class="num">${s.n}</td><td class="num">${ci}</td>
      <td class="num">${server?.r !== null && server?.r !== undefined ? server.r.toFixed(2) : '—'}</td>
    </tr>`;
  });
  document.getElementById('corr-stats').innerHTML = `
    <thead><tr><th>关系（滞后 1 天）</th><th>r</th><th>样本 n</th><th>95% CI</th><th>后端 r*</th></tr></thead>
    <tbody>${rows.join('')}</tbody>`;
};

// --------------------------------------------------------------- heatmap

const HEAT_KEYS = METRICS.map((m) => m).filter((m) =>
  ['sleep_total_min', 'hrv_avg', 'rhr', 'stress_avg', 'load_short', 'steps'].includes(m.key)
);

const renderHeatmap = () => {
  const m = metric(state.heat) || metric('sleep_total_min');
  const container = document.getElementById('heatmap');
  const all = state.data.daily;
  const values = all.map((r) => r[state.heat]);
  const nums = values.filter((v) => v !== null && v !== undefined);
  const lo = Math.min(...nums), hi = Math.max(...nums);
  const defRank = (v) => (v === null || v === undefined ? 0 : (v - lo) / (hi - lo || 1));

  const months = new Map();
  for (const r of all) {
    if (r.date < addDays(all.at(-1).date, -400)) continue;
    const monthKey = r.date.slice(0, 7);
    if (!months.has(monthKey)) months.set(monthKey, []);
    months.get(monthKey).push(r);
  }
  container.innerHTML = [...months.entries()]
    .map(([month, rows]) => {
      const cells = rows
        .map((r) => {
          const v = r[state.heat];
          const ratio = defRank(v);
          const hasData = v !== null && v !== undefined;
          return `<button type="button" class="hcell${hasData ? '' : ' nodata'}${r.date === selectedDate() ? ' sel' : ''}"
            data-date="${r.date}" style="--v:${ratio}"
            aria-label="${r.date} ${m.label} ${hasData ? m.fmt(v) : '无数据'}">${r.date.slice(8)}</button>`;
        })
        .join('');
      return `<div class="hmonth"><div class="hmonth-title">${month}</div><div class="hgrid">${cells}</div></div>`;
    })
    .join('');

  const legend = document.createElement('div');
  legend.className = 'heat-legend';
  legend.innerHTML = `<span>${m.unit || m.label}</span><span class="bar"><i></i></span><span style="text-align:right">${nums.length ? (hi >= 1000 ? `${num(lo)}–${num(hi)}` : `${num(lo, 1)}–${num(hi, 1)}`) : '—'}</span>`;
  container.append(legend);
};

const selectedDate = () => state.selectedDate || null;

const renderDayDetail = () => {
  const box = document.getElementById('day-detail');
  const date = selectedDate();
  if (!date) {
    box.hidden = true;
    box.innerHTML = '';
    return;
  }
  const rows = state.data.daily;
  const row = rows.find((r) => r.date === date);
  if (!row) {
    box.hidden = false;
    box.innerHTML = `<p class="note">${date} 无每日数据。</p>`;
    return;
  }
  const acts = (state.data.activities_recent || []).filter(
    (a) => a.date === addDays(date, -1) || a.date === date || a.date === addDays(date, 1)
  );
  const stage = (v) => (v === null || v === undefined ? '缺失' : `${v} 分钟`);
  box.hidden = false;
  box.innerHTML = `
    <div class="dd-head"><b>${date}</b>
      <button type="button" class="tool" id="dd-close">关闭</button></div>
    <div class="dd-grid">
      <div><b>睡眠（相对醒来日）</b> 总 ${hmin(row.sleep_total_min)} · 深 ${stage(row.deep)} · 浅 ${stage(row.light)} · REM ${stage(row.rem)} · 清醒 ${stage(row.awake)} · 分 ${num(row.sleep_score)}</div>
      <div><b>恢复相关（同为醒来日）</b> HRV ${num(row.hrv_avg)} ms（基线 ${num(row.hrv_baseline)} ms）· 睡眠均心率 ${num(row.sleep_hr_avg)} bpm</div>
      <div><b>本日（自然日）</b> 静息 ${num(row.rhr)} bpm · 日均 ${num(row.avg_hr)} bpm · 压力 ${num(row.stress_avg)} 分 · 步数 ${num(row.steps)} · 负荷短/长 ${num(row.load_short)}/${num(row.load_long)}（比 ${num(row.load_ratio, 2)}）</div>
      <div><b>训练背景（−1/0/+1 天）</b>
        ${acts.length ? acts.map((a) => `<span class="tag">${a.date} ${a.sport}${a.distance_km ? ` ${num(a.distance_km, 2)} km` : ''}${a.duration_min ? ` ${num(a.duration_min)} min` : ''}</span>`).join('') : '无记录（或超出近 90 天范围）'}
      </div>
      <div><b>状态</b> ${row.stage_completeness < 1 ? `睡眠分期完整性 ${Math.round(row.stage_completeness * 100)}%（缺失段按缺失显示）` : '分期完整'}</div>
    </div>`;
  document.getElementById('dd-close').onclick = () => {
    state.selectedDate = null;
    renderDayDetail();
    renderHeatmap();
  };
};

// ------------------------------------------------------------- activities

const renderActivities = () => {
  const acts = (state.data.activities_recent || [])
    .slice(-40)
    .reverse();
  const rowsHtml = acts
    .map(
      (a) => `<tr><td>${a.date}</td><td>${a.sport}</td>
      <td>${a.distance_km ? num(a.distance_km, 2) + ' km' : '—'}</td>
      <td>${a.duration_min ? num(a.duration_min) + ' min' : '—'}</td>
      <td>${a.avg_hr ? num(a.avg_hr) + ' bpm' : '—'}</td>
      <td>${a.calories ? num(a.calories) + ' kcal' : '—'}</td></tr>`
    )
    .join('');
  document.getElementById('activities').innerHTML = `
    <thead><tr><th>日期</th><th>类型</th><th>距离</th><th>时长</th><th>均心率</th><th>卡路里</th></tr></thead>
    <tbody>${rowsHtml || '<tr><td colspan="6">暂无运动记录</td></tr>'}</tbody>
    <caption>显示最近 ${acts.length} 条（完整列表见 data/activities.csv，注意其中含城市级位置字段）</caption>`;
};

// ------------------------------------------------------------- insights

const renderWeekly = () => {
  const weeks = state.data.insights?.weekly || [];
  document.getElementById('weekly').innerHTML = `
    <thead><tr><th>周</th><th>睡眠 h</th><th>HRV</th><th>静息</th><th>压力</th><th>短期负荷</th><th>运动 min</th></tr></thead>
    <tbody>${weeks
      .map(
        (w) =>
          `<tr><td>${w.week}</td><td class="num">${w.sleep_h ?? '—'}</td><td class="num">${w.hrv ?? '—'}</td>
           <td class="num">${w.rhr ?? '—'}</td><td class="num">${w.stress ?? '—'}</td>
           <td class="num">${w.load_short ?? '—'}</td><td class="num">${w.exercise_min ?? '—'}</td></tr>`
      )
      .join('')}</tbody>`;
};

const renderHypotheses = () => {
  const items = state.data.insights?.hypotheses || [];
  document.getElementById('hypotheses').innerHTML =
    items.length === 0
      ? '<li>样本不足，暂无可生成假设</li>'
      : items
          .map(
            (h) =>
              `<li><b>${h.label}</b> ${h.delta > 0 ? '+' : ''}${num(h.delta, 1)} ${h.unit}${h.unit ? ' ' : ''}
                <span class="muted">（${h.note}）</span></li>`
          )
          .join('');
};

// ------------------------------------------------------------- quality

const QUALITY_ROWS = [
  ['sleep_total_min', '睡眠时长'],
  ['sleep_score', '睡眠分'],
  ['sleep_hr_avg', '睡眠均心率'],
  ['hrv_avg', '夜间 HRV'],
  ['rhr', '静息心率'],
  ['avg_hr', '日均心率'],
  ['stress_avg', '平均压力'],
  ['steps', '步数'],
  ['load_short', '短期负荷'],
  ['load_long', '长期负荷'],
  ['load_ratio', '负荷比'],
];

const renderQuality = () => {
  const q = state.quality;
  if (!q) {
    document.getElementById('quality-table').innerHTML =
      '<tbody><tr><td>data_quality.json 加载失败，展示原始值时请以 data/ 为准</td></tr></tbody>';
    return;
  }
  const rows = QUALITY_ROWS.map(([key, label]) => {
    const m = q.metrics[key];
    if (!m) return '';
    const miss = m.missing_90d ?? m.missing_total;
    const zeros = m.zeros?.zeros ? `${m.zeros.zeros}${m.zeros.suspicious ? ' ⚠' : ''}` : '—';
    const anomalies = m.anomaly_count ? `${m.anomaly_count}` : '—';
    return `<tr><td>${label}</td><td class="num">${fmtPct(m.missing_total)}</td>
      <td class="num">${fmtPct(m.missing_30d)}</td><td class="num">${fmtPct(m.missing_90d)}</td>
      <td class="num">${zeros}</td><td class="num">${anomalies}</td>
      <td class="num">${m.obs_days}</td></tr>`;
  }).join('');
  document.getElementById('quality-table').innerHTML = `
    <thead><tr><th>指标</th><th>缺失（全部）</th><th>缺失（30 天）</th><th>缺失（90 天）</th><th>0 值天数</th><th>异常日累计</th><th>有效天数</th></tr></thead>
    <tbody>${rows}</tbody>
    <caption>异常日=滚动 MAD 稳健 z 分数超出 ±3.5 的日期（阈值仅提示节律偏离，需要人工核对生理意义）。</caption>`;
};

// ---------------------------------------------------------- daily table

const DAILY_COLS = [
  ['date', '日期'],
  ['sleep_total_min', '睡眠总'], ['sleep_score', '睡眠分'],
  ['deep', '深'], ['light', '浅'], ['rem', 'REM'], ['awake', '清醒'],
  ['hrv_avg', 'HRV'], ['hrv_baseline', '基线'], ['deviation_hrv', 'HRVΔ'],
  ['rhr', '静息'], ['stress_avg', '压力'], ['steps', '步数'],
  ['load_short', '短负荷'], ['load_long', '长负荷'], ['load_ratio', '负荷比'],
];

const renderDailyTable = () => {
  const limit = state.dailyExpanded ? state.rangeRows.length : state.dailyLimit;
  const rows = state.rangeRows.slice(0, limit);
  const more = state.rangeRows.length - rows.length;

  // scrape HRV deviation from series for display
  const allIdx = (r) => state.data.daily.indexOf(r);
  const dev = (r) => state.data.series.hrv.deviation[allIdx(r)];

  document.getElementById('daily-table').innerHTML = `
    <thead><tr>${DAILY_COLS.map(([, t]) => `<th>${t}</th>`).join('')}</tr></thead>
    <tbody>
      ${rows
        .map((r) => {
          const vals = {
            date: r.date,
            sleep_total_min: r.sleep_total_min === null || r.sleep_total_min === undefined ? '缺失' : r.sleep_total_min,
            sleep_score: r.sleep_score ?? '缺失',
            deep: r.deep ?? '缺', light: r.light ?? '缺', rem: r.rem ?? '缺', awake: r.awake ?? '缺',
            hrv_avg: r.hrv_avg ?? '缺失', hrv_baseline: r.hrv_baseline ?? '—',
            deviation_hrv: dev(r) === null ? '—' : (dev(r) > 0 ? '+' : '') + num(dev(r), 1),
            rhr: r.rhr ?? '缺失', stress_avg: r.stress_avg ?? '缺失', steps: r.steps ?? '缺失',
            load_short: r.load_short ?? '—', load_long: r.load_long ?? '—',
            load_ratio: r.load_ratio ?? '—',
          };
          return `<tr><td>${vals.date}</td>${DAILY_COLS.slice(1)
            .map(([k]) => `<td class="num">${vals[k]}</td>`)
            .join('')}</tr>`;
        })
        .join('')}
    </tbody>
    <caption>${rows.length}/${state.rangeRows.length} 行（当前范围）；“缺”=该睡眠分期当日缺失（非 0）。HRVΔ=相对 28 天个人基线差。</caption>`;

  // "load more" button lives outside the table so it never scrolls sideways
  const wrap = document.getElementById('daily-table-wrap');
  let btn = document.getElementById('daily-more');
  if (!btn) {
    btn = document.createElement('button');
    btn.type = 'button';
    btn.id = 'daily-more';
    btn.className = 'tool load-more';
    wrap.after(btn);
  }
  if (more > 0 && !state.dailyExpanded) {
    btn.hidden = false;
    btn.textContent = `再显示 ${Math.min(200, more)} 行（还有 ${more}）`;
    btn.onclick = () => {
      state.dailyLimit += 200;
      renderDailyTable();
    };
  } else {
    btn.hidden = true;
  }

  // horizontal-scroll hint only when the table really overflows its container
  updateScrollHint();
};

const updateScrollHint = () => {
  const hint = document.getElementById('scroll-hint');
  const wrap = document.getElementById('daily-table-wrap');
  if (!hint || !wrap) return;
  hint.dataset.visible = String(wrap.scrollWidth > wrap.clientWidth + 2);
};

const exportCsv = () => {
  const cols = [
    'date', 'steps', 'calories', 'exercise_min', 'stress_avg',
    'sleep_score', 'sleep_total_min', 'deep', 'light', 'rem', 'awake', 'stage_completeness',
    'sleep_hr_avg', 'hrv_avg', 'hrv_status', 'hrv_baseline', 'rhr', 'avg_hr',
    'load_short', 'load_long', 'load_ratio', 'window_start', 'window_end',
  ];
  const esc = (v) => (v === null || v === undefined ? '' : String(v).includes(',') ? `"${v}"` : String(v));
  const lines = [cols.join(',')];
  for (const r of state.rangeRows) lines.push(cols.map((c) => esc(r[c])).join(','));
  const blob = new Blob([lines.join('\n')], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `daily_${state.range ? `last${state.range}d` : 'all'}.csv`;
  a.click();
  URL.revokeObjectURL(url);
};

// ------------------------------------------------------------ coverage

const COVERAGE_NAMES = {
  daily_health: '每日健康汇总', sleep: '睡眠', hrv: 'HRV', avg_hr: '日均心率',
  rhr: '静息心率', stress_daily: '压力（日）', load: '训练负荷', activities: '运动记录',
};

const renderCoverage = () => {
  const rowsHtml = Object.entries(state.data.coverage || {})
    .map(
      ([key, v]) =>
        `<tr><td>${COVERAGE_NAMES[key] || key}</td><td>${v.start || '—'}</td><td>${v.end || '—'}</td><td class="num">${num(v.rows)}</td></tr>`
    )
    .join('');
  document.getElementById('coverage').innerHTML = `
    <thead><tr><th>数据表</th><th>开始</th><th>结束</th><th>行数</th></tr></thead>
    <tbody>${rowsHtml}</tbody>`;
};

// ------------------------------------------------------- tables per chart

const renderChartTable = (id) => {
  const rows = state.rangeRows;
  const r = rows.at(-1) || {};
  const defs = {
    sleepChart: {
      cols: ['日期', '总时长', '深睡', '浅睡', 'REM', '清醒', '完整性'],
      fmt: (row) => [
        row.date, hmin(row.sleep_total_min), row.deep ?? '缺', row.light ?? '缺',
        row.rem ?? '缺', row.awake ?? '缺',
        `${Math.round((row.stage_completeness ?? 0) * 100)}%`,
      ],
    },
    hrvChart: {
      cols: ['日期', 'HRV', '7 天', '28 天基线', '设备基线', '偏差'],
      fmt: (row) => {
        const i = state.data.daily.indexOf(row);
        const s = state.data.series.hrv;
        const v = row.hrv_avg;
        const d28 = s.mean_28d[i] != null && v != null ? v - s.mean_28d[i] : null;
        return [
          row.date, v ?? '缺失', s.mean_7d[i] ?? '—', s.mean_28d[i] ?? '—',
          s.device_baseline[i] ?? '—', d28 === null ? '—' : (d28 > 0 ? '+' : '') + num(d28),
        ];
      },
    },
    rhrChart: {
      cols: ['日期', '静息心率', '7 天均值'],
      fmt: (row) => {
        const s = state.data.series.rhr;
        return [
          row.date, row.rhr ?? '缺失',
          s.mean_7d[state.data.daily.indexOf(row)] ?? '—',
        ];
      },
    },
    stressChart: {
      cols: ['日期', '平均压力', '7 天均值'],
      fmt: (row) => {
        const s = state.data.series.stress_avg;
        return [
          row.date, row.stress_avg ?? '缺失',
          s.mean_7d[state.data.daily.indexOf(row)] ?? '—',
        ];
      },
    },
    stepsChart: {
      cols: ['日期', '步数', '7 天均值'],
      fmt: (row) => {
        const s = state.data.series.steps;
        return [
          row.date, row.steps ?? '缺失',
          s.mean_7d[state.data.daily.indexOf(row)] ?? '—',
        ];
      },
    },
    loadChart: {
      cols: ['日期', '短期', '长期', '负荷比'],
      fmt: (row) => [
        row.date, row.load_short ?? '—', row.load_long ?? '—', row.load_ratio ?? '—',
      ],
    },
  };
  if (id === 'weightChart') {
    const w = state.data.series.weight_kg;
    const rows = w.dates.map((d, i) => [d, w.values[i], w.mean_7d?.[i] ?? '—']);
    return `<table class="coverage table-inline">
      <thead><tr><th>日期</th><th>体重 kg</th><th>近 7 次均值</th></tr></thead>
      <tbody>${rows
        .slice(-120)
        .map((r) => `<tr>${r.map((v) => `<td>${v == null ? '缺失' : v}</td>`).join('')}</tr>`)
        .join('')}</tbody>
      <caption>${rows.length > 120 ? '仅显示最近 120 次称重' : `共 ${rows.length} 次称重`}</caption>
    </table>`;
  }
  const def = defs[id];
  if (!def) return '';
  const noteRow = id === 'sleepChart' && ((r.stage_completeness ?? 1) < 1)
    ? `<tr><td colspan="${def.cols.length}">注意：部分日期分期缺失（灰色），缺失不等于 0。</td></tr>`
    : '';
  return `
    <table class="coverage table-inline">
      <thead><tr>${def.cols.map((c) => `<th>${c}</th>`).join('')}</tr></thead>
      <tbody>
        ${noteRow}
        ${rows
          .slice(-120)
          .map(
            (row) =>
              `<tr>${def
                .fmt(row)
                .map((v) => `<td>${v === null || v === undefined ? '缺失' : v}</td>`)
                .join('')}</tr>`
          )
          .join('')}
      </tbody>
      <caption>${rows.length > 120 ? '仅显示最近 120 天；全量请用导出 CSV' : `共 ${rows.length} 天`}</caption>
    </table>`;
};

const wireTables = () => {
  document.querySelectorAll('[data-table-for]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const id = btn.dataset.tableFor;
      const box = document.getElementById(`table-${id}`);
      const open = box.hidden;
      box.hidden = !open;
      btn.setAttribute('aria-expanded', String(open));
      if (open) box.innerHTML = renderChartTable(id);
    });
  });
};

// ------------------------------------------------------------------ wiring

const applyRange = (n) => {
  state.range = n;
  // switching range resets the progressive table back to the first page
  state.dailyLimit = 30;
  state.dailyExpanded = false;
  const toggle = document.getElementById('toggle-daily');
  if (toggle) {
    toggle.textContent = '展开全部';
    toggle.setAttribute('aria-expanded', 'false');
  }
  document.querySelectorAll('#range button').forEach((b) => {
    const active = Number(b.dataset.range) === n;
    b.classList.toggle('active', active);
    b.setAttribute('aria-pressed', String(active));
  });
  document.getElementById('range-label').textContent =
    n === 0 ? '时间范围：全部' : `时间范围：最近 ${n} 天`;
  renderCharts();
};

const showFatal = (message) => {
  setStatus('err', message);
  const kpis = document.getElementById('kpis');
  if (!kpis) {
    showTopBanner(`<b>数据加载失败</b><br>${message}`);
    return;
  }
  kpis.innerHTML = `
    <div class="kpi"><span class="value">!</span>
      <span class="label">数据加载失败</span>
      <span class="sub">${message}</span></div>`;
};

const init = async () => {
  if (isStaleBuild()) {
    showStaleBuildNotice();
    return;
  }
  chartDefaults();
  try {
    const [dataResp, qualityResp] = await Promise.all([
      fetch('./data.json', { cache: 'no-store' }),
      fetch('./data_quality.json', { cache: 'no-store' }),
    ]);
    if (!dataResp.ok) throw new Error(`data.json HTTP ${dataResp.status}`);
    state.data = await dataResp.json();
    state.quality = qualityResp.ok ? await qualityResp.json() : null;
  } catch (error) {
    showFatal(`数据加载失败：${error.message}。可能网络不可达或文件缺失，原始数据仍在 GitHub 仓库。`);
    return;
  }
  if (!state.data.daily || !state.data.daily.length) {
    showFatal('data.json 存在但没有任何每日数据（同步可能没跑过）。');
    return;
  }

  // correlation select
  const sel = document.getElementById('corr-select');
  CORR_DEFS.forEach((def, i) => {
    const opt = document.createElement('option');
    opt.value = String(i);
    opt.textContent = def.label;
    sel.append(opt);
  });
  state.corrKey = 0;

  document.getElementById('range').addEventListener('click', (e) => {
    const btn = e.target.closest('button');
    if (btn) applyRange(Number(btn.dataset.range));
  });

  document.getElementById('corr-select').addEventListener('change', (e) => {
    state.corrKey = Number(e.target.value);
    renderCorrChart();
    renderCorrStats();
  });
  document.getElementById('corr-lag').addEventListener('change', (e) => {
    state.corrLag = Number(e.target.value);
    renderCorrChart();
  });

  document.getElementById('heat-metric').addEventListener('change', (e) => {
    state.heat = e.target.value;
    renderHeatmap();
  });

  document.getElementById('heatmap').addEventListener('click', (e) => {
    const cell = e.target.closest('.hcell');
    if (!cell) return;
    state.selectedDate = cell.dataset.date;
    renderDayDetail();
    renderHeatmap();
  });

  document.getElementById('toggle-daily').addEventListener('click', (e) => {
    state.dailyExpanded = !state.dailyExpanded;
    state.dailyLimit = state.dailyExpanded ? state.rangeRows.length : 30;
    e.currentTarget.textContent = state.dailyExpanded ? '收起' : '展开全部';
    e.currentTarget.setAttribute('aria-expanded', String(state.dailyExpanded));
    renderDailyTable();
  });

  document.getElementById('toggle-compact').addEventListener('click', (e) => {
    const table = document.getElementById('daily-table');
    const on = !table.classList.contains('compact');
    table.classList.toggle('compact', on);
    e.currentTarget.setAttribute('aria-pressed', String(on));
    updateScrollHint();
  });

  window.addEventListener(
    'resize',
    () => {
      clearTimeout(state._hintTimer);
      state._hintTimer = setTimeout(updateScrollHint, 150);
    },
    { passive: true }
  );

  // back-to-top: appears after one screen of scrolling
  const toTop = document.getElementById('back-to-top');
  const onScroll = () => {
    toTop.hidden = window.scrollY < window.innerHeight * 0.8;
  };
  window.addEventListener('scroll', onScroll, { passive: true });
  onScroll();
  toTop.addEventListener('click', () => {
    const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    window.scrollTo({ top: 0, behavior: reduce ? 'auto' : 'smooth' });
  });

  document.getElementById('export-csv').addEventListener('click', exportCsv);

  // 键盘可达：canvas Enter/Space → 打开等效数据表
  document.querySelectorAll('canvas[role="img"]').forEach((canvas) => {
    canvas.tabIndex = 0;
    canvas.setAttribute('aria-describedby', `table-${canvas.id}`);
    canvas.addEventListener('keydown', (e) => {
      if (e.key !== 'Enter' && e.key !== ' ') return;
      e.preventDefault();
      const btn = document.querySelector(`[data-table-for="${canvas.id}"]`);
      if (btn) {
        btn.click();
        btn.focus();
      }
    });
  });

  wireTables();
  applyRange(90);

  // phones start with the compact daily table (5 core columns)
  if (window.matchMedia('(max-width: 767px)').matches) {
    document.getElementById('daily-table').classList.add('compact');
    const compactBtn = document.getElementById('toggle-compact');
    compactBtn.setAttribute('aria-pressed', 'true');
    updateScrollHint();
  }

  window.matchMedia('(prefers-reduced-motion: reduce)').addEventListener('change', () => {
    for (const ch of Object.values(charts)) ch.destroy();
    renderCharts();
  });
};

init().catch((error) => showFatal('初始化失败：' + error.message));
