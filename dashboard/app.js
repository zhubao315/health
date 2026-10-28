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

// Semantic palette (Tailwind 400/500 range). Every chart picks its colour from
// here so a metric keeps the same hue everywhere: sleep is indigo, HRV emerald,
// resting heart rate rose, stress amber, steps/load cyan.
const C = {
  cyan: '#22d3ee',
  sky: '#38bdf8',
  indigo: '#6366f1',
  purple: '#a855f7',
  rose: '#f43f5e',
  emerald: '#10b981',
  amber: '#f59e0b',
  periwinkle: '#818cf8',
  slate: '#64748b',
  text: '#e6eaf0',
  muted: '#8b95a5',
  grid: 'rgba(255, 255, 255, 0.05)',
  // aggregation lines stay neutral; series are separated by dash pattern too
  line: '#c7d2fe',
  lineDim: '#7c8795',
  // legacy aliases still referenced by a few call sites
  accent: '#22d3ee',
  accent2: '#38bdf8',
  red: '#f43f5e',
  ok: '#10b981',
  warn: '#f59e0b',
  green: '#10b981',
};

const MONO = "'Fira Code', ui-monospace, SFMono-Regular, Menlo, monospace";
const AXIS_COLOR = '#64748b';

// hex -> rgba, so gradients can reuse the palette without extra literals
const hexA = (hex, alpha) => {
  const h = String(hex).replace('#', '');
  const full = h.length === 3 ? h.split('').map((c) => c + c).join('') : h;
  const n = parseInt(full, 16);
  if (Number.isNaN(n)) return `rgba(34, 211, 238, ${alpha})`;
  return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${alpha})`;
};

// Vertical area gradient: 28% at the top edge of the plot area -> transparent at
// the bottom. Scriptable so it survives resize (chartArea is unknown at config).
const areaFill = (hex, top = 0.28, bottom = 0) => (context) => {
  const { ctx, chartArea } = context.chart;
  if (!chartArea) return hexA(hex, top);
  const g = ctx.createLinearGradient(0, chartArea.top, 0, chartArea.bottom);
  g.addColorStop(0, hexA(hex, top));
  g.addColorStop(1, hexA(hex, bottom));
  return g;
};

// Vertical bar gradient: brighter at the top of each bar.
const barFill = (hex, top = 0.95, bottom = 0.35) => (context) => {
  // `parsed` lives on the scriptable context, not on the chart instance
  const { ctx, chartArea } = context.chart;
  if (!chartArea) return hexA(hex, top);
  const y = context.parsed?.y ?? chartArea.bottom;
  const g = ctx.createLinearGradient(0, y, 0, chartArea.bottom);
  g.addColorStop(0, hexA(hex, top));
  g.addColorStop(1, hexA(hex, bottom));
  return g;
};

// Diagonal hatch for "measured nothing" days — a marker, never a zero value.
const hatchPattern = (context, color = 'rgba(148, 163, 184, 0.5)') => {
  const { ctx } = context.chart;
  const size = 6;
  const tile = document.createElement('canvas');
  tile.width = size;
  tile.height = size;
  const t = tile.getContext('2d');
  t.strokeStyle = color;
  t.lineWidth = 1.2;
  t.beginPath();
  t.moveTo(-size, size);
  t.lineTo(size, -size);
  t.moveTo(0, size * 2);
  t.lineTo(size * 2, 0);
  t.stroke();
  return ctx.createPattern(tile, 'repeat');
};

const chartDefaults = () => {
  Chart.defaults.color = C.muted;
  Chart.defaults.borderColor = 'transparent';
  Chart.defaults.font.family = MONO;
  Chart.defaults.font.size = 11;
  // Native canvas tooltips are replaced by the DOM card (#chart-tip).
  Chart.defaults.plugins.tooltip.enabled = false;
  Chart.defaults.plugins.tooltip.external = externalTooltip;
  Chart.defaults.plugins.legend.labels.usePointStyle = true;
  Chart.defaults.plugins.legend.labels.pointStyle = 'circle';
  Chart.defaults.plugins.legend.labels.boxWidth = 6;
  Chart.defaults.plugins.legend.labels.boxHeight = 6;
  Chart.defaults.plugins.legend.labels.padding = 14;
  Chart.defaults.plugins.legend.labels.color = C.muted;
  Chart.defaults.plugins.legend.labels.font = { family: MONO, size: 11 };
  Chart.defaults.elements.line.tension = 0.35;
  Chart.defaults.elements.line.borderWidth = 2.2;
  Chart.defaults.elements.point.hoverBorderWidth = 3;
  if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
    Chart.defaults.animation = false;
  }
};

const charts = {};

// ------------------------------------------- synced crosshair + glass tooltip
// One DOM tooltip card serves every chart (Chart.js native canvas tooltips are
// disabled). Hovering a daily chart also draws a glowing crosshair on its
// siblings and highlights the same day's points on all of them.

const SYNC_GROUPS = {
  sleepChart: 'recovery',
  hrvChart: 'recovery',
  rhrChart: 'recovery',
  stressChart: 'recovery',
  stepsChart: 'recovery',
  loadChart: 'load',
  loadRatioChart: 'load',
};

const syncState = { group: null, index: null };

const WEEKDAYS = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];
const weekdayOf = (iso) => {
  const d = new Date(iso + 'T00:00:00');
  return Number.isNaN(d.getTime()) ? '' : WEEKDAYS[d.getDay()];
};

const tipEl = () => {
  let el = document.getElementById('chart-tip');
  if (!el) {
    el = document.createElement('div');
    el.id = 'chart-tip';
    el.className = 'chart-tip';
    el.hidden = true;
    el.setAttribute('role', 'status');
    el.setAttribute('aria-live', 'polite');
    document.body.appendChild(el);
  }
  return el;
};

// dataset colours can be strings, arrays or scriptable functions
const datasetColor = (chart, ds) => {
  const raw = typeof ds.borderColor === 'function' ? ds.borderColor({ chart }) : ds.borderColor;
  if (typeof raw === 'string') return raw;
  if (Array.isArray(ds.backgroundColor) && typeof ds.backgroundColor[0] === 'string') {
    return ds.backgroundColor[0];
  }
  return C.cyan;
};

const tipValue = (label, value, unit) => {
  if (value === null || value === undefined) return '缺失';
  if (unit === 'min' || /睡眠|时长|深睡|浅睡|REM|清醒/.test(label)) return hmin(value);
  if (unit === 'km') return `${num(value, 1)} km`;
  if (unit) return `${num(value, 1)} ${unit}`;
  return num(value, 1);
};

const chartUnit = (chart) => chart.$unit || '';

// baseline for the hovered index: an explicit 28-day line when the chart has
// one, otherwise the centre of the ±1 SD corridor, otherwise nothing.
const tipBaseline = (chart, index) => {
  const ds = chart.data.datasets;
  const line = ds.findIndex((d) => typeof d.label === 'string' && /28 天/.test(d.label));
  if (line >= 0) {
    const v = ds[line].data[index];
    if (v != null) return { value: v, source: '28 天基线' };
  }
  const band = ds.findIndex((d) => typeof d.label === 'string' && /走廊/.test(d.label));
  if (band >= 0) {
    const up = ds[band].data[index];
    const lo = ds[band + 1]?.data[index];
    if (up != null && lo != null) {
      return { value: (up + lo) / 2, sd: Math.abs(up - lo) / 2, source: '28 天基线' };
    }
  }
  return null;
};

const chartTipHtml = (chart, index) => {
  const iso = chart.$dates?.[index] || null;
  const unit = chartUnit(chart);
  const rows = [];
  chart.data.datasets.forEach((ds, i) => {
    if (!ds.label || /走廊|参考线|拟合/.test(ds.label)) return;
    if (chart.getDatasetMeta(i).hidden) return;
    const raw = ds.data[index];
    const value = raw && typeof raw === 'object' ? raw.y : raw;
    if (value === null || value === undefined) return;
    rows.push({ label: ds.label, value, color: datasetColor(chart, ds) });
  });
  if (!rows.length) return '';

  const base = tipBaseline(chart, index);
  const primary = rows[0];
  let deltaHtml = '';
  let badge = '';
  if (base && base.value) {
    const diff = primary.value - base.value;
    const pct = (diff / base.value) * 100;
    const z = base.sd ? diff / base.sd : null;
    deltaHtml = `<span class="tip-delta">${base.source} ${diff > 0 ? '+' : ''}${num(diff, 1)}${
      unit ? ' ' + unit : ''
    }（${pct > 0 ? '+' : ''}${pct.toFixed(0)}%）</span>`;
    if (z != null && Math.abs(z) >= 1.5) {
      badge = `<span class="tip-badge ${z > 0 ? 'up' : 'down'}">${z > 0 ? '+' : ''}${z.toFixed(1)} SD</span>`;
    }
  }

  // other metrics of the same day, so the card is a snapshot, not a single line
  const rowData = iso ? state.data.daily.find((r) => r.date === iso) : null;
  const extra = typeof chart.$tipExtra === 'function' ? chart.$tipExtra(index) : null;
  const snapshot = extra
    ? extra.filter(Boolean).join(' · ')
    : rowData
    ? [
        rowData.hrv_avg != null ? `HRV ${num(rowData.hrv_avg)}` : null,
        rowData.rhr != null ? `静息 ${num(rowData.rhr)}` : null,
        rowData.stress_avg != null ? `压力 ${num(rowData.stress_avg)}` : null,
        rowData.load_ratio != null ? `负荷比 ${num(rowData.load_ratio, 2)}` : null,
      ]
        .filter(Boolean)
        .join(' · ')
    : '';

  const head = iso
    ? `<div class="tip-head">
        <span class="tip-date">${iso.slice(5)}</span>
        <span class="tip-wd">${weekdayOf(iso)}</span>
        ${badge}
      </div>`
    : `<div class="tip-head"><span class="tip-date">${chart.data.labels[index] ?? ''}</span></div>`;

  const body = rows
    .map(
      (r) => `<li>
        <i class="tip-dot" style="--c:${r.color}"></i>
        <span class="tip-name">${r.label}</span>
        <b class="tip-val">${tipValue(r.label, r.value, unit)}</b>
      </li>`
    )
    .join('');

  // $tipExtra (e.g. weekly training counts) renders even without ISO dates;
  // the day snapshot only makes sense on dated charts.
  const snapText = extra
    ? extra.filter(Boolean).join(' · ')
    : snapshot && iso
      ? snapshot
      : '';
  const footHtml =
    deltaHtml || snapText
      ? `<div class="tip-foot">${deltaHtml}${
          snapText ? `<span class="tip-snapshot">${snapText}</span>` : ''
        }</div>`
      : '';
  return `${head}<ul class="tip-rows">${body}</ul>${footHtml}`;
};

const positionTip = (el, chart, tooltip) => {
  const rect = chart.canvas.getBoundingClientRect();
  const pad = 14;
  const x = rect.left + tooltip.caretX;
  const y = rect.top + tooltip.caretY;
  el.style.left = '0px';
  el.style.top = '0px';
  const size = el.getBoundingClientRect();
  let left = x + pad;
  let top = y + pad;
  if (left + size.width > window.innerWidth - 10) left = x - size.width - pad;
  if (top + size.height > window.innerHeight - 10) top = y - size.height - pad;
  el.style.left = `${Math.max(10, left)}px`;
  el.style.top = `${Math.max(10, top)}px`;
};

const externalTooltip = (context) => {
  const { chart, tooltip } = context;
  const el = tipEl();
  if (!chart || !tooltip || tooltip.opacity === 0) {
    el.hidden = true;
    return;
  }
  const index = tooltip.dataPoints?.[0]?.dataIndex;
  if (index === undefined || index === null) {
    el.hidden = true;
    return;
  }
  const html = chartTipHtml(chart, index);
  if (!html) {
    el.hidden = true;
    return;
  }
  el.innerHTML = html;
  el.hidden = false;
  positionTip(el, chart, tooltip);
};

let syncFrame = 0;
const refreshSyncCharts = () => {
  if (syncFrame) return;
  syncFrame = requestAnimationFrame(() => {
    syncFrame = 0;
    for (const id of Object.keys(charts)) {
      if (charts[id].$syncGroup === syncState.group) charts[id].update('none');
    }
  });
};

const setSyncHover = (group, index) => {
  if (index === null || index === undefined) {
    if (syncState.index !== null) {
      syncState.group = null;
      syncState.index = null;
      refreshSyncCharts();
    }
    return;
  }
  if (syncState.index === index && syncState.group === group) return;
  syncState.group = group;
  syncState.index = index;
  refreshSyncCharts();
};

// Glowing vertical crosshair + halo on the hovered value of every synced chart.
const crosshairPlugin = {
  id: 'syncCrosshair',
  afterDatasetsDraw(chart) {
    if (syncState.index === null) return;
    if (!chart.$syncGroup || chart.$syncGroup !== syncState.group) return;
    const { ctx, chartArea, scales } = chart;
    if (!scales.x || !chartArea) return;
    if (syncState.index >= scales.x.max) return;
    const x = scales.x.getPixelForValue(syncState.index);
    if (!Number.isFinite(x)) return;

    ctx.save();
    ctx.beginPath();
    ctx.moveTo(x, chartArea.top);
    ctx.lineTo(x, chartArea.bottom);
    ctx.lineWidth = 1;
    ctx.setLineDash([]);
    ctx.strokeStyle = 'rgba(34, 211, 238, 0.45)';
    ctx.shadowColor = 'rgba(34, 211, 238, 0.65)';
    ctx.shadowBlur = 10;
    ctx.stroke();
    ctx.restore();

    chart.data.datasets.forEach((ds, di) => {
      if (!ds.label || /走廊|参考线|拟合|均值|基线/.test(ds.label)) return;
      const meta = chart.getDatasetMeta(di);
      if (meta.hidden) return;
      const el = meta.data[syncState.index];
      if (!el || el.skip) return;
      const color = datasetColor(chart, ds);
      ctx.save();
      ctx.beginPath();
      ctx.arc(el.x, el.y, 4, 0, Math.PI * 2);
      ctx.fillStyle = '#07090d';
      ctx.strokeStyle = color;
      ctx.lineWidth = 2;
      ctx.shadowColor = hexA(color.startsWith('#') ? color : '#22d3ee', 0.8);
      ctx.shadowBlur = 8;
      ctx.fill();
      ctx.stroke();
      ctx.restore();
    });
  },
};

const syncInteraction = (group) => ({
  onHover: (_event, elements) => {
    setSyncHover(group, elements.length ? elements[0].index : null);
  },
  onClick: (_event, elements) => {
    if (!elements.length) return;
    const row = state.rangeRows[elements[0].index];
    if (!row) return;
    state.selectedDate = row.date;
    renderHeatmap();
    renderDayDetail();
    const box = document.getElementById('day-detail');
    if (box && !box.hidden) box.scrollIntoView({ behavior: 'smooth', block: 'center' });
  },
});

Chart.register(crosshairPlugin);

const makeChart = (id, config) => {
  if (charts[id]) charts[id].destroy();
  const canvas = document.getElementById(id);
  if (!canvas) return null;
  const group = SYNC_GROUPS[id];
  if (group) {
    config.options = { ...(config.options || {}), ...syncInteraction(group) };
  }
  const chart = new Chart(canvas, config);
  chart.$syncGroup = group || null;
  // $unit may sit on the config root or inside options (chartOptions merges it
  // into the options object); fall back to the y-axis title text.
  const unitOpt = config.$unit !== undefined ? config.$unit : config.options?.$unit;
  chart.$unit = unitOpt !== undefined ? unitOpt : config.options?.scales?.y?.title?.text || '';
  const labels = config.data?.labels || [];
  const firstLabel = String(labels[0] ?? '');
  chart.$dates = /^\d{4}-\d{2}-\d{2}$/.test(firstLabel)
    ? labels.slice()
    : group
      ? state.rangeRows.map((r) => r.date)
      : null;
  charts[id] = chart;
  if (group && !canvas.$syncBound) {
    canvas.$syncBound = true;
    canvas.addEventListener('mouseleave', () => setSyncHover(group, null));
    canvas.addEventListener('blur', () => setSyncHover(group, null));
  }
  return chart;
};


const round1 = (v) => Math.round(v * 10) / 10;

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
  range: 90, // 7 / 30 / 90 / 365 / 0(全部)
  customRange: null, // {start, end} ISO dates; overrides `range` when set
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
  { key: 'sleep_total_min', label: '睡眠时长', unit: 'min', fmt: hmin, wake: true, color: '#6366f1' },
  { key: 'hrv_avg', label: '夜间 HRV', unit: 'ms', fmt: (v) => `${num(v)} ms`, wake: true, color: '#10b981' },
  { key: 'rhr', label: '静息心率', unit: 'bpm', fmt: (v) => `${num(v)} bpm`, wake: false, color: '#f43f5e' },
  { key: 'stress_avg', label: '平均压力', unit: '分', fmt: (v) => num(v), wake: false, color: '#f59e0b' },
  { key: 'load_short', label: '短期负荷', unit: '', fmt: (v) => num(v), wake: false, color: '#22d3ee' },
  { key: 'steps', label: '步数', unit: '步', fmt: (v) => num(v), wake: false, color: '#38bdf8' },
  { key: 'sleep_score', label: '睡眠分', unit: '分', fmt: (v) => num(v), wake: true, color: '#a855f7' },
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

// Per-metric polarity: which direction is "better" for this person's own
// baseline. Load and steps are deliberately neutral — a high value is neither
// good nor bad without context, so they never get a warning colour.
const POLARITY = {
  sleep_total_min: 'up',
  sleep_score: 'up',
  hrv_avg: 'up',
  rhr: 'down',
  stress_avg: 'down',
  load_short: null,
  steps: null,
};

// Deviation tone: amber when the deviation is in the unfavourable direction,
// green when it is favourable, muted when flat / unknown. Never red: a single
// day outside the personal baseline is not an alarm.
const deviationTone = (key, deltaPct) => {
  const polarity = POLARITY[key];
  if (polarity == null || deltaPct == null) return 'neutral';
  if (Math.abs(deltaPct) < 5) return 'flat';
  const favourable = polarity === 'up' ? deltaPct > 0 : deltaPct < 0;
  return favourable ? 'good' : 'warn';
};

// Area sparkline: 7 points, gradient fill under a monotone stroke, and a
// breathing dot on the latest value. Decorative only (aria-hidden) — the same
// numbers are in the card text.
const areaSparkline = (values, color) => {
  const vals = values.slice(-7);
  if (vals.filter((v) => v != null).length < 2) return '';
  const present = vals.filter((v) => v != null);
  const min = Math.min(...present);
  const max = Math.max(...present);
  const span = max - min || 1;
  const step = 100 / Math.max(1, vals.length - 1);
  const pts = [];
  vals.forEach((v, i) => {
    if (v == null) return;
    pts.push([i * step, 24 - ((v - min) / span) * 18]);
  });
  if (pts.length < 2) return '';
  const line = pts.map(([x, y], i) => `${i ? 'L' : 'M'}${x.toFixed(1)},${y.toFixed(1)}`).join(' ');
  const area = `${line} L${pts.at(-1)[0].toFixed(1)},28 L${pts[0][0].toFixed(1)},28 Z`;
  const [lx, ly] = pts.at(-1);
  const id = `sg${Math.random().toString(36).slice(2, 8)}`;
  return `<svg class="spark" viewBox="0 0 100 28" preserveAspectRatio="none" aria-hidden="true">
    <defs>
      <linearGradient id="${id}" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0%" stop-color="${color}" stop-opacity="0.35" />
        <stop offset="100%" stop-color="${color}" stop-opacity="0" />
      </linearGradient>
    </defs>
    <path d="${area}" fill="url(#${id})" />
    <path d="${line}" fill="none" stroke="${color}" stroke-width="1.6"
      stroke-linecap="round" vector-effect="non-scaling-stroke" />
    <circle class="spark-dot" cx="${lx.toFixed(1)}" cy="${ly.toFixed(1)}" r="2"
      fill="${color}" />
  </svg>`;
};

// generic sparkline over a bare value array (body composition card)
const seriesSparkline = (values, color) => {
  const pts = values.filter((v) => v !== null && v !== undefined).slice(-30);
  if (pts.length < 3) return '';
  const min = Math.min(...pts);
  const max = Math.max(...pts);
  const span = max - min || 1;
  const step = 100 / (pts.length - 1);
  const d = pts
    .map((v, i) => `${(i * step).toFixed(1)},${(16 - ((v - min) / span) * 13).toFixed(1)}`)
    .join(' ');
  return `<svg class="spark" viewBox="0 0 100 20" preserveAspectRatio="none" aria-hidden="true">
    <polyline points="${d}" fill="none" stroke="${color}" stroke-width="1.3"
      stroke-linejoin="round" vector-effect="non-scaling-stroke" />
  </svg>`;
};

// Bullet bar: a normal-range band (28d mean ± 1 SD when available), the 7-day
// mean as a tick and the single day as a glowing dot.
const bulletBar = (m, value, v7, v28, sd) => {
  const pts = [value, v7, v28].filter((v) => v != null);
  if (pts.length < 2) return '';
  const bandLo = v28 != null && sd ? v28 - sd : null;
  const bandHi = v28 != null && sd ? v28 + sd : null;
  const domainPts = pts.concat(bandLo != null ? [bandLo, bandHi] : []);
  const lo = Math.min(...domainPts);
  const hi = Math.max(...domainPts);
  const pad = (hi - lo) * 0.22 || Math.abs(hi) * 0.08 || 1;
  const domainLo = lo - pad;
  const domainHi = hi + pad;
  const pos = (v) => Math.max(0, Math.min(100, ((v - domainLo) / (domainHi - domainLo)) * 100));
  const label = [
    bandLo != null ? `常态区间 ${m.fmt(bandLo)}–${m.fmt(bandHi)}` : null,
    v28 != null ? `28 天基线 ${m.fmt(v28)}` : null,
    v7 != null ? `7 天均值 ${m.fmt(v7)}` : null,
    value != null ? `单日 ${m.fmt(value)}` : null,
  ]
    .filter(Boolean)
    .join('，');
  const bandStyle =
    bandLo != null
      ? `left:${pos(bandLo).toFixed(1)}%;width:${Math.max(1, pos(bandHi) - pos(bandLo)).toFixed(1)}%`
      : '';
  return `<span class="bullet" role="img" aria-label="${label}" title="${label}">
    <span class="bullet-track" aria-hidden="true"></span>
    ${bandStyle ? `<span class="bullet-band" style="${bandStyle}" aria-hidden="true"></span>` : ''}
    ${v28 != null ? `<span class="bullet-tick base" style="left:${pos(v28).toFixed(1)}%" aria-hidden="true"></span>` : ''}
    ${v7 != null ? `<span class="bullet-tick week" style="left:${pos(v7).toFixed(1)}%" aria-hidden="true"></span>` : ''}
    ${value != null ? `<span class="bullet-dot" style="left:${pos(value).toFixed(1)}%" aria-hidden="true"></span>` : ''}
  </span>`;
};

const buildKpis = () => {
  const d = state.data;
  const latestDate =
    d.coverage?.daily_health?.end || state.rangeRows.at(-1)?.date || '';
  // 28-day SD around the latest day, for the normal-range band on the bullet
  const sdAt = (key) => {
    const band = baselineBand(d.daily.map((r) => r[key]));
    const idx = d.daily.findIndex((r) => r.date === (d.latest[key]?.date || latestDate));
    if (idx < 0 || band.upper[idx] == null) return null;
    const sd = (band.upper[idx] - band.lower[idx]) / 2;
    return sd > 0 ? sd : null;
  };

  const cards = METRICS.map((m) => {
    const latest = d.latest[m.key] || {};
    const v7 = seriesAt(m.key, 'mean_7d', latest.date || latestDate);
    const v28 = seriesAt(m.key, 'mean_28d', latest.date || latestDate);
    // steps are a cumulative daily counter and the latest day may still be
    // partial, so its delta is taken from the 7-day mean instead of a single
    // day that could read as a 97% collapse.
    const basis = m.key === 'steps' ? v7 : latest.value;
    const d28 = v28 !== null && basis !== null ? basis - v28 : null;
    const pct = v28 ? (d28 / v28) * 100 : null;
    const dir = m.key === 'sleep_score' ? null : direction(d28, (v28 || 1) * 0.05);
    const tone = deviationTone(m.key, pct);
    const metricColor = m.color || C.cyan;
    const pill = dir
      ? `<span class="kpi-pill ${tone}">${dir.glyph}${
          tone === 'flat'
            ? ' 持平'
            : d28 === null
              ? ''
              : ` ${num(Math.abs(d28), m.key === 'steps' ? 0 : 1)}${m.unit ? ' ' + m.unit : ''}`
        }</span>`
      : '';
    const basisNote = m.key === 'steps' ? '7 天均值 vs 28 天基线' : '单日 vs 28 天基线';
    const valueText = m.fmt(latest.value);
    return `
      <article class="kpi kpi-${tone}">
        <header class="kpi-head">
          <span class="kpi-name">${m.label}</span>
          ${pill}
        </header>
        <div class="kpi-sub">
          <span class="kpi-date">${latest.date || latestDate}</span>
          <span class="kpi-basis">7d ${m.fmt(v7)} · 28d ${m.fmt(v28)}</span>
        </div>
        <div class="kpi-value">${valueText}</div>
        ${bulletBar(m, latest.value, v7, v28, sdAt(m.key))}
        <div class="spark-wrap">
          ${areaSparkline(d.daily.slice(-7).map((r) => r[m.key]), metricColor)}
          <span class="spark-note">近 7 天 · ${basisNote}</span>
        </div>
      </article>`;
  });
  const box = document.getElementById('kpis');
  box.innerHTML = cards.join('');
  box.removeAttribute('aria-busy');
};

// ------------------------------------------------------------------ charts

const filterRows = () => {
  const all = state.data.daily;
  if (state.customRange) {
    return all.filter(
      (r) => r.date >= state.customRange.start && r.date <= state.customRange.end
    );
  }
  return state.range > 0 ? all.slice(-state.range) : all;
};

const shortDate = (r) => r.date.slice(5);

// Smooth monotone line with an optional area gradient underneath.
const lineDataset = (label, accessor, color, extra = {}) => ({
  label,
  data: state.rangeRows.map(accessor),
  borderColor: color,
  backgroundColor: areaFill(color),
  borderWidth: 2.2,
  cubicInterpolationMode: 'monotone',
  pointRadius: 0,
  pointHoverRadius: 5,
  pointHoverBackgroundColor: '#07090d',
  pointHoverBorderColor: color,
  pointHoverBorderWidth: 2.5,
  spanGaps: false,
  ...extra,
});

// Trailing 28-day mean ± 1 SD, drawn as a shaded corridor behind a series so
// that a point outside the person's own normal band is visible at a glance.
// Fewer than 14 observations in the window yields no band (not a zero band).
const baselineBand = (values, window = 28, minObs = 14) => {
  const upper = [];
  const lower = [];
  for (let i = 0; i < values.length; i++) {
    const w = values
      .slice(Math.max(0, i - window + 1), i + 1)
      .filter((v) => v !== null && v !== undefined);
    if (w.length < minObs) {
      upper.push(null);
      lower.push(null);
      continue;
    }
    const mean = w.reduce((a, b) => a + b, 0) / w.length;
    const sd = Math.sqrt(w.reduce((a, b) => a + (b - mean) ** 2, 0) / (w.length - 1));
    upper.push(round1(mean + sd));
    lower.push(round1(mean - sd));
  }
  return { upper, lower };
};

const bandUpper = (upper, label) => ({
  label,
  data: upper,
  type: 'line',
  borderWidth: 0,
  pointRadius: 0,
  pointHoverRadius: 0,
  fill: '+1',
  backgroundColor: 'rgba(148, 163, 184, 0.08)',
});

const bandLower = (lower) => ({
  label: '',
  data: lower,
  type: 'line',
  borderWidth: 0,
  pointRadius: 0,
  pointHoverRadius: 0,
  fill: false,
});

// The corridor always uses the full history (trailing 28 days), then is sliced
// to the visible window — otherwise a 7-day view could never show a 28-day band.
const corridorDatasets = (rows, key) => {
  const all = state.data.daily;
  const start = all.indexOf(rows[0]);
  if (start < 0 || !rows.length) return [];
  const full = baselineBand(all.map((r) => r[key]));
  const upper = full.upper.slice(start, start + rows.length);
  const lower = full.lower.slice(start, start + rows.length);
  if (!upper.some((v) => v != null)) return [];
  return [bandUpper(upper, '基线走廊 ±1 SD'), bandLower(lower)];
};

// Minimal axes: no axis lines, no tick marks, no vertical grid; only very faint
// dashed horizontal rules.
const axisTicks = (maxTicks) => ({
  color: AXIS_COLOR,
  font: { family: MONO, size: 11 },
  padding: 8,
  maxTicksLimit: maxTicks,
  autoSkip: true,
});

const baseScales = (unit, stacked = false) => ({
  x: {
    grid: { display: false },
    border: { display: false },
    ticks: { ...axisTicks(9), maxRotation: 0 },
    stacked,
  },
  y: {
    grid: {
      color: C.grid,
      borderDash: [3, 3],
      drawTicks: false,
      tickLength: 0,
    },
    border: { display: false, dash: [3, 3] },
    ticks: { ...axisTicks(5), maxTicksLimit: 5 },
    stacked,
    title: unit
      ? { display: true, text: unit, color: '#475569', font: { family: MONO, size: 10 } }
      : { display: false },
  },
});

const chartOptions = (unit, extra = {}) => ({
  responsive: true,
  maintainAspectRatio: false,
  animation: window.matchMedia('(prefers-reduced-motion: reduce)').matches
    ? false
    : { duration: 320 },
  interaction: { mode: 'index', intersect: false },
  layout: { padding: { top: 4, right: 4 } },
  plugins: {
    legend: { display: false },
    tooltip: { enabled: false, external: externalTooltip, mode: 'index', intersect: false },
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
      labels: {
        boxWidth: 6,
        boxHeight: 6,
        usePointStyle: true,
        pointStyle: 'circle',
        padding: 14,
        color: C.muted,
        font: { family: MONO, size: 11 },
        filter: (item) => !!(item.text && item.text.trim()),
      },
    },
  },
});

// ------------------------------------------------- body composition (scale)
// Every body view follows the global range selector: the presets filter by
// calendar days (7/30/90/365/all) and the custom range filters by its dates.

const bodyAnchor = () => {
  const lastDaily = state.rangeRows.at(-1)?.date;
  const lastBody = state.data.body?.at(-1)?.date;
  if (!lastDaily) return lastBody;
  if (!lastBody) return lastDaily;
  return lastDaily > lastBody ? lastDaily : lastBody;
};

const bodyRows = () => {
  const rows = state.data.body || [];
  if (state.customRange) {
    return rows.filter(
      (r) => r.date >= state.customRange.start && r.date <= state.customRange.end
    );
  }
  if (state.range === 0) return rows;
  const anchor = bodyAnchor();
  if (!anchor) return rows;
  const start = new Date(new Date(anchor + 'T00:00:00').getTime() - (state.range - 1) * 86400000);
  const startISO = start.toISOString().slice(0, 10);
  return rows.filter((r) => r.date >= startISO);
};

const rolling7 = (values, minObs = 4) =>
  values.map((_, i) => {
    const w = values
      .slice(Math.max(0, i - 6), i + 1)
      .filter((v) => v !== null && v !== undefined);
    return w.length >= minObs
      ? Math.round((w.reduce((a, b) => a + b, 0) / w.length) * 10) / 10
      : null;
  });

const bodySeries = (key) => {
  const rows = bodyRows();
  const labels = rows.map((r) => r.date);
  const values = rows.map((r) => (r[key] == null ? null : r[key]));
  return { rows, labels, values, mean7: rolling7(values) };
};

// body metric matrix: latest value, date, change vs the previous reading and a
// mini trend. fat_mass is derived (weight x body-fat) and labelled as such.
const BODY_METRICS = [
  ['weight_kg', '体重', 'kg', 1],
  ['bmi', 'BMI', '', 1],
  ['body_fat_pct', '体脂率', '%', 1],
  ['fat_mass', '脂肪量', 'kg', 1],
  ['muscle_pct', '肌肉率', '%', 1],
  ['water_pct', '水分率', '%', 1],
  ['protein_pct', '蛋白质', '%', 1],
  ['bone_kg', '骨量', 'kg', 1],
  ['visceral_fat', '内脏脂肪', '级', 0],
  ['bmr', '基础代谢', 'kcal', 0],
  ['body_age', '身体年龄', '岁', 0],
];

const metricValue = (row, key) => {
  if (key === 'bmi') {
    // the scale also reports BMI; recompute from the profile height so there is
    // exactly one source of truth (the two agree to within rounding)
    return bmiOf(row.weight_kg);
  }
  if (key === 'fat_mass') {
    return row.weight_kg != null && row.body_fat_pct != null
      ? Math.round(row.weight_kg * row.body_fat_pct) / 100
      : null;
  }
  return row[key];
};

// single BMI formula for the whole app: weight / height(m)^2, height from profile
const heightM = () => (state.data.profile?.height_cm || 186) / 100;
const bmiOf = (kg) =>
  kg == null || !heightM() ? null : Math.round((kg / heightM() ** 2) * 10) / 10;

const renderProfilePills = () => {
  const box = document.getElementById('header-meta');
  const alt = document.getElementById('hero-meta');
  if (!box && !alt) return;
  const h = state.data.profile?.height_cm ?? 186;
  const rows = (state.data.body || []).filter((r) => r.weight_kg != null);
  const last = rows.at(-1);
  const bmi = last ? bmiOf(last.weight_kg) : null;
  const latest = state.data.daily?.at(-1)?.date;
  const html = [
    `<span class="pill-meta">身高 ${h} cm</span>`,
    last ? `<span class="pill-meta">体重 ${num(last.weight_kg, 1)} kg</span>` : '',
    bmi != null ? `<span class="pill-meta">BMI ${num(bmi, 1)}</span>` : '',
    latest ? `<span class="pill-meta">数据至 ${latest}</span>` : '',
  ]
    .filter(Boolean)
    .join('');
  if (box) box.innerHTML = html;
  if (alt) alt.innerHTML = html;
};

const renderProfile = () => {
  const box = document.getElementById('profile-card');
  if (!box) return;
  const height = state.data.profile?.height_cm ?? 186;
  const rows = (state.data.body || []).filter((r) => r.weight_kg != null);
  const last = rows.at(-1) || null;
  const bmi = last ? bmiOf(last.weight_kg) : null;
  box.innerHTML = `
    <div class="profile-main">
      <span class="profile-label">身高</span>
      <span class="profile-value">${height}<small>cm</small></span>
      <span class="profile-note">固定档案值 · 用于 BMI 计算</span>
    </div>
    <div class="profile-item">
      <span class="profile-label">体重</span>
      <span class="profile-value">${last ? num(last.weight_kg, 1) : '暂无数据'}<small>${last ? 'kg' : ''}</small></span>
      <span class="profile-note">${last ? last.date : '没有称重记录'}</span>
    </div>
    <div class="profile-item">
      <span class="profile-label">BMI</span>
      <span class="profile-value">${bmi == null ? '暂无数据' : num(bmi, 1)}<small>${bmi == null ? '' : ''}</small></span>
      <span class="profile-note">${bmi == null ? '需要有效体重' : `按身高 ${height} cm 计算`}</span>
    </div>`;
};

// ---------------------------------------------------- executive summary
// Four cards answering: current state vs baseline / what is trending /
// what looks unusual / what to verify next. Everything is computed from the
// payload — no narrative is invented when the data cannot support it.

const meanSd = (values) => {
  const v = values.filter((x) => x !== null && x !== undefined);
  if (v.length < 2) return { mean: null, sd: null, n: v.length };
  const mean = v.reduce((a, b) => a + b, 0) / v.length;
  const sd = Math.sqrt(v.reduce((a, b) => a + (b - mean) ** 2, 0) / (v.length - 1));
  return { mean, sd, n: v.length };
};

const pctDelta = (value, base) =>
  value == null || base == null || base === 0 ? null : ((value - base) / base) * 100;

const execStateCard = () => {
  const d = state.data;
  const rows = d.daily;
  const last = rows.at(-1);
  if (!last) return { title: '近期状态 vs 基线', body: '暂无数据', tone: 'muted', icon: 'state' };
  const specs = [
    ['sleep_total_min', '睡眠', true],
    ['hrv_avg', 'HRV', true],
    ['rhr', '静息心率', false],
    ['stress_avg', '压力', false],
  ];
  const parts = [];
  let good = 0;
  let bad = 0;
  for (const [key, label, higherIsBetter] of specs) {
    const s = d.series[key];
    if (!s) continue;
    const idx = rows.findIndex((r) => r.date === last.date);
    const base = s.mean_28d?.[idx];
    const value = last[key];
    if (value == null || base == null) continue;
    const pct = pctDelta(value, base);
    if (pct == null) continue;
    const better = higherIsBetter ? pct > 0 : pct < 0;
    const near = Math.abs(pct) < 3;
    if (near) {
      parts.push(`${label}持平`);
    } else {
      parts.push(`${label}${pct > 0 ? '偏高' : '偏低'}${Math.abs(pct).toFixed(0)}%`);
      if (better) good += 1;
      else bad += 1;
    }
  }
  if (!parts.length) return { title: '近期状态 vs 基线', body: '基线样本不足（需 20 天以上）', tone: 'muted', icon: 'state' };
  const tone = bad === 0 ? 'good' : good >= bad ? 'neutral' : 'warn';
  const lead =
    bad === 0
      ? '整体平稳'
      : good >= bad
        ? '多数指标在基线附近'
        : '有指标明显偏离基线';
  return { title: '近期状态 vs 基线', body: `${lead}：${parts.join(' · ')}`, tone, icon: 'state' };
};

const execTrendCard = () => {
  const hs = (state.data.insights?.hypotheses || []).slice();
  if (!hs.length) return { title: '持续变化的指标', body: '暂无足够数据', tone: 'muted', icon: 'trend' };
  const scale = { sleep_total_min: 60, hrv_avg: 5, rhr: 2, stress_avg: 5 };
  hs.sort((a, b) => Math.abs(b.delta) / (scale[b.metric] || 1) - Math.abs(a.delta) / (scale[a.metric] || 1));
  const top = hs.slice(0, 2).map((h) => {
    const dir = h.delta > 0 ? '↑' : '↓';
    const unit = h.metric === 'sleep_total_min' ? 'min' : h.unit;
    return `${h.label} ${dir}${Math.abs(h.delta).toFixed(1)} ${unit}`;
  });
  return {
    title: '持续变化的指标',
    body: `近 7 天 vs 前 28 天：${top.join(' · ')}`,
    tone: 'neutral',
    icon: 'trend',
  };
};

const execAnomalyCard = () => {
  const rows = state.data.daily;
  if (rows.length < 30) return { title: '值得观察的异常', body: '历史不足 30 天，暂不扫描', tone: 'muted', icon: 'alert' };
  const window = rows.slice(-14);
  const specs = [
    ['sleep_total_min', '睡眠'],
    ['hrv_avg', 'HRV'],
    ['rhr', '静息心率'],
    ['stress_avg', '压力'],
    ['steps', '步数'],
  ];
  const flags = [];
  for (const [key, label] of specs) {
    const all = rows.map((r) => r[key]);
    const start = rows.length - 14 - 28;
    const baseVals = all.slice(Math.max(0, start), rows.length - 14);
    const { mean, sd } = meanSd(baseVals);
    if (mean == null || !sd) continue;
    window.forEach((r, i) => {
      const v = r[key];
      if (v == null) return;
      const z = (v - mean) / sd;
      if (Math.abs(z) >= 1.5) {
        flags.push({ date: r.date, label, z, value: v });
      }
    });
  }
  if (!flags.length) return { title: '值得观察的异常', body: '最近 14 天各指标均在个人 ±1.5 SD 内', tone: 'good', icon: 'alert' };
  flags.sort((a, b) => Math.abs(b.z) - Math.abs(a.z));
  const top = flags.slice(0, 2).map((f) => `${f.date.slice(5)} ${f.label} ${f.z > 0 ? '+' : ''}${f.z.toFixed(1)} SD`);
  return { title: '值得观察的异常', body: `最近 14 天：${top.join(' · ')}`, tone: 'warn', icon: 'alert' };
};

const execNextCard = () => {
  const cs = (state.data.correlations || []).filter((c) => c.r != null);
  if (!cs.length) return { title: '下一步验证', body: '相关性样本不足', tone: 'muted', icon: 'link' };
  cs.sort((a, b) => Math.abs(b.r) - Math.abs(a.r));
  const c = cs[0];
  return {
    title: '下一步验证',
    body: `${c.label}：r=${c.r.toFixed(2)}（95% CI ${c.ci_low.toFixed(2)}~${c.ci_high.toFixed(2)}，n=${c.n}）。相关不等于因果，可在下方切换滞后天数复看。`,
    tone: 'neutral',
    icon: 'link',
  };
};

// small inline icons for the four summary cards (no emoji: they vary per OS)
const EXEC_ICONS = {
  state:
    '<path d="M3 12h4l2.5-7 5 14L17 12h4" />',
  trend:
    '<path d="M3 17l6-6 4 4 7-8" /><path d="M20 7h-5" /><path d="M20 7v5" />',
  alert:
    '<path d="M12 3.5 21 20H3z" /><path d="M12 9v5" /><path d="M12 17h.01" />',
  link:
    '<path d="M9.5 14.5a3.5 3.5 0 0 0 5 0l3-3a3.5 3.5 0 0 0-5-5l-1 1" />' +
    '<path d="M14.5 9.5a3.5 3.5 0 0 0-5 0l-3 3a3.5 3.5 0 0 0 5 5l1-1" />',
};

const execIcon = (key) =>
  `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7"
     stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${
       EXEC_ICONS[key] || EXEC_ICONS.state
     }</svg>`;

// wrap the numbers that carry the conclusion so they read as data, not prose
const highlightNumbers = (text) =>
  text.replace(
    /([-+±]?\d[\d,]*(?:\.\d+)?\s?(?:%|ms|bpm|min|分|SD|kg|步)|[-+±]?\d{1,3}(?:,\d{3})+)/g,
    '<span class="hl">$1</span>'
  );

const renderExecutiveSummary = () => {
  const box = document.getElementById('exec-grid');
  if (!box) return;
  const cards = [execStateCard(), execTrendCard(), execAnomalyCard(), execNextCard()];
  box.innerHTML = cards
    .map(
      (c) => `
      <article class="exec-card ${c.tone}">
        <header class="exec-head">
          <span class="exec-icon ${c.tone}">${execIcon(c.icon)}</span>
          <span class="exec-title">${c.title}</span>
        </header>
        <p class="exec-body">${highlightNumbers(c.body)}</p>
      </article>`
    )
    .join('');
};

const renderBodyMetrics = () => {
  const box = document.getElementById('body-metrics');
  if (!box) return;
  const rows = bodyRows();
  if (!rows.length) {
    box.innerHTML = '';
    return;
  }
  const cards = [];
  for (const [key, label, unit, digits] of BODY_METRICS) {
    const values = rows.map((r) => metricValue(r, key));
    let idx = -1;
    for (let i = values.length - 1; i >= 0; i--) {
      if (values[i] !== null && values[i] !== undefined) {
        idx = i;
        break;
      }
    }
    if (idx < 0) continue;
    let prev = null;
    for (let i = idx - 1; i >= 0; i--) {
      if (values[i] !== null && values[i] !== undefined) {
        prev = values[i];
        break;
      }
    }
    const delta = prev === null ? null : values[idx] - prev;
    const derived = key === 'fat_mass' ? ' <span class="derived">计算</span>' : '';
    cards.push(`
      <div class="metric-card">
        <span class="metric-name">${label}${derived}</span>
        <span class="metric-value">${num(values[idx], digits)}<small>${unit}</small></span>
        <span class="metric-meta">${rows[idx].date}${delta === null ? '' : ` · 较上次 ${delta > 0 ? '+' : ''}${num(delta, digits === 0 ? 0 : 1)}`}</span>
        ${seriesSparkline(values, key === 'body_fat_pct' ? C.amber : C.accent)}
      </div>`);
  }
  const last = rows[rows.length - 1];
  const days = Math.round(
    (Date.now() - new Date(last.date + 'T00:00:00').getTime()) / 86400000
  );
  const note =
    days >= 0 && days <= 400
      ? `<p class="metric-note">区间内最后一次称重：${last.date}（${days === 0 ? '今天' : days + ' 天前'}）</p>`
      : '';
  box.innerHTML = `<div class="metric-grid">${cards.join('')}</div>${note}`;
};

const renderBodyYears = () => {
  const box = document.getElementById('body-years');
  const rows = bodyRows();
  if (!box) return;
  if (!rows.length) {
    box.innerHTML = '';
    return;
  }
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
      <caption>只统计当前时间范围内的称重记录；「—」表示当年没有体脂数据（只测了体重）</caption>
    </table>`;
};

const renderBodyScatter = () => {
  const rows = bodyRows().filter(
    (r) => r.bmi != null && r.body_fat_pct != null
  );
  if (rows.length < 4) return;
  const byYear = new Map();
  for (const r of rows) {
    const y = r.date.slice(0, 4);
    if (!byYear.has(y)) byYear.set(y, []);
    byYear.get(y).push({ x: r.bmi, y: r.body_fat_pct, date: r.date });
  }
  const palette = [
    '#22d3ee', '#38bdf8', '#6366f1', '#a855f7', '#f43f5e',
    '#f59e0b', '#10b981', '#818cf8', '#fb7185', '#2dd4bf',
  ];
  const years = [...byYear.keys()].sort();
  makeChart('bodyScatterChart', {
    type: 'scatter',
    data: {
      datasets: years.map((y, i) => {
        const c = palette[i % palette.length];
        return {
          label: y,
          data: byYear.get(y),
          backgroundColor: hexA(c, 0.5),
          borderColor: c,
          borderWidth: 1,
          pointRadius: 3.2,
          pointHoverRadius: 6,
          pointHoverBackgroundColor: '#07090d',
          pointHoverBorderWidth: 2,
        };
      }),
    },
    options: {
      ...chartOptions(''),
      plugins: {
        ...withLegend({ plugins: {} }).plugins,
        legend: {
          display: true,
          position: 'bottom',
          labels: {
            boxWidth: 6,
            boxHeight: 6,
            usePointStyle: true,
            pointStyle: 'circle',
            padding: 12,
            color: C.muted,
            font: { family: MONO, size: 11 },
          },
        },
      },
      scales: {
        ...baseScales(''),
        x: { ...baseScales('').x, title: { display: true, text: 'BMI', color: '#475569', font: { family: MONO, size: 10 } } },
        y: { ...baseScales('').y, title: { display: true, text: '体脂率 %', color: '#475569', font: { family: MONO, size: 10 } } },
      },
    },
  });
};

// week-over-week weight change, paired against the last weigh-in 21-90 days back
const weightRateSeries = () => {
  const rows = bodyRows().filter((r) => r.weight_kg != null);
  const out = { labels: [], values: [] };
  for (let i = 0; i < rows.length; i++) {
    const cur = rows[i];
    const t0 = new Date(cur.date + 'T00:00:00').getTime();
    let j = i - 1;
    while (j >= 0) {
      const dt = (t0 - new Date(rows[j].date + 'T00:00:00').getTime()) / 86400000;
      if (dt >= 21) {
        if (dt <= 90) {
          out.labels.push(cur.date);
          out.values.push(round1(((cur.weight_kg - rows[j].weight_kg) / dt) * 7));
        }
        break;
      }
      j -= 1;
    }
  }
  return out;
};

const renderBodyRate = () => {
  const { labels, values } = weightRateSeries();
  if (!labels.length) return;
  makeChart('weightRateChart', {
    type: 'bar',
    data: {
      labels,
      datasets: [
        {
          label: '体重变化 kg/周',
          data: values,
          backgroundColor: values.map((v) =>
            v > 0.05 ? hexA(C.amber, 0.75) : v < -0.05 ? hexA(C.cyan, 0.75) : hexA(C.slate, 0.5)
          ),
          hoverBackgroundColor: values.map((v) =>
            v > 0.05 ? C.amber : v < -0.05 ? C.cyan : C.slate
          ),
          borderRadius: 4,
          borderSkipped: false,
          barPercentage: 0.7,
          categoryPercentage: 0.85,
        },
      ],
    },
    options: {
      ...chartOptions('kg/周'),
      plugins: { legend: { display: false } },
    },
  });
};

const renderBodyComposition = () => {
  const rows = bodyRows().filter(
    (r) => r.weight_kg != null && r.body_fat_pct != null
  );
  if (rows.length < 2) return;
  const fat = rows.map((r) => Math.round(r.weight_kg * r.body_fat_pct) / 100);
  const lean = rows.map((r, i) => Math.round((r.weight_kg - fat[i]) * 10) / 10);
  makeChart(
    'bodyCompChart',
    withLegend({
      type: 'line',
      data: {
        labels: rows.map((r) => r.date),
        datasets: [
          {
            label: '脂肪量 kg',
            data: fat,
            backgroundColor: areaFill(C.amber, 0.35, 0.12),
            borderColor: C.amber,
            borderWidth: 2,
            fill: 'origin',
            stack: 'comp',
            pointRadius: 0,
            cubicInterpolationMode: 'monotone',
          },
          {
            label: '去脂体重 kg',
            data: lean,
            backgroundColor: areaFill(C.cyan, 0.28, 0.08),
            borderColor: C.cyan,
            borderWidth: 2,
            fill: 'origin',
            stack: 'comp',
            pointRadius: 0,
            cubicInterpolationMode: 'monotone',
          },
        ],
      },
      options: withLegend(chartOptions('kg'), true),
    })
  );
};

const destroyBodyCharts = () => {
  for (const id of ['weightChart', 'bodyFatChart', 'bodyScatterChart', 'weightRateChart', 'bodyCompChart']) {
    if (charts[id]) {
      charts[id].destroy();
      delete charts[id];
    }
  }
};

const rangeStartDate = () => {
  if (state.customRange) return state.customRange.start;
  if (state.range === 0) return null;
  const anchor = state.rangeRows.at(-1)?.date;
  if (!anchor) return null;
  const d = new Date(
    new Date(anchor + 'T00:00:00').getTime() - (state.range - 1) * 86400000
  );
  return d.toISOString().slice(0, 10);
};

const renderTrainingChart = () => {
  const all = state.data.training || [];
  const start = rangeStartDate();
  const weeks = start ? all.filter((w) => w.week >= start) : all;
  if (!weeks.length) return;
  const chart = makeChart('trainingChart', {
    type: 'bar',
    data: {
      labels: weeks.map((w) => w.week.slice(5)),
      datasets: [
        {
          label: '跑步 km',
          data: weeks.map((w) => w.run_km),
          backgroundColor: barFill(C.emerald, 0.95, 0.4),
          hoverBackgroundColor: C.emerald,
          borderRadius: 5,
          borderSkipped: false,
          barPercentage: 0.68,
          categoryPercentage: 0.84,
        },
        {
          label: '骑行 km',
          data: weeks.map((w) => w.ride_km),
          backgroundColor: barFill(C.sky, 0.95, 0.4),
          hoverBackgroundColor: C.sky,
          borderRadius: 5,
          borderSkipped: false,
          barPercentage: 0.68,
          categoryPercentage: 0.84,
        },
      ],
    },
    options: withLegend(
      chartOptions('km', {
        scales: {
          ...baseScales('km'),
          x: { ...baseScales('km').x, stacked: false },
        },
      })
    ),
  });
  if (chart) {
    chart.$tipExtra = (i) => {
      const w = weeks[i];
      if (!w) return [];
      return [
        `跑步 ${w.runs} 次 · 骑行 ${w.rides} 次 · 徒步 ${w.hikes} 次`,
        `总时长 ${Math.round(w.minutes)} 分钟`,
      ];
    };
  }
};

const renderBodyCharts = () => {
  const empty = document.getElementById('body-empty');
  const grid = document.querySelector('#body-card .body-charts');
  const rows = bodyRows();
  const enough = rows.length >= 2;
  // a single weigh-in still gives a valid latest value, just no trend
  if (empty) {
    empty.hidden = enough;
    empty.textContent =
      rows.length === 0
        ? '当前时间范围内没有称重记录。切换到更长的时间范围，或下次称重后会自动出现。'
        : '当前时间范围内只有 1 次称重，不足以画趋势；最新一次已显示在上方。';
  }
  if (grid) grid.hidden = !enough;
  if (!rows.length) {
    destroyBodyCharts();
    document.getElementById('body-metrics').innerHTML = '';
    document.getElementById('body-years').innerHTML = '';
    return;
  }
  renderBodyMetrics();
  if (!enough) {
    destroyBodyCharts();
    document.getElementById('body-years').innerHTML = '';
    return;
  }

  const w = bodySeries('weight_kg');
  const f = bodySeries('body_fat_pct');
  makeChart(
    'weightChart',
    withLegend({
      type: 'line',
      data: {
        labels: w.labels,
        datasets: [
          lineDataset('体重', () => null, C.sky, {
            data: w.values,
            fill: true,
            backgroundColor: areaFill(C.sky, 0.26),
            pointRadius: 2.4,
            pointHoverRadius: 5,
            pointBackgroundColor: '#07090d',
            pointBorderColor: C.sky,
            pointBorderWidth: 1.6,
          }),
          lineDataset('近 7 次均值', () => null, C.line, {
            data: w.mean7,
            borderWidth: 1.4,
            borderDash: [4, 4],
            backgroundColor: 'transparent',
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
        labels: f.labels,
        datasets: [
          lineDataset('体脂率', () => null, C.amber, {
            data: f.values,
            fill: true,
            backgroundColor: areaFill(C.amber, 0.26),
            pointRadius: 2.4,
            pointHoverRadius: 5,
            pointBackgroundColor: '#07090d',
            pointBorderColor: C.amber,
            pointBorderWidth: 1.6,
          }),
          lineDataset('近 7 次均值', () => null, C.line, {
            data: f.mean7,
            borderWidth: 1.4,
            borderDash: [4, 4],
            backgroundColor: 'transparent',
          }),
        ],
      },
      options: withLegend(chartOptions('%'), true),
    })
  );
  renderBodyScatter();
  renderBodyRate();
  renderBodyComposition();
  renderBodyYears();
};

// Missing-stage marker: a small hatched capsule at the bottom of the plot area.
// It marks "no stage breakdown recorded", never a 0-minute stage.
const missingStagePlugin = {
  id: 'missingStages',
  afterDatasetsDraw(chart) {
    const flags = chart.$missingStages;
    if (!flags || !flags.some(Boolean)) return;
    const { ctx, chartArea, scales } = chart;
    if (!chartArea || !scales.x) return;
    flags.forEach((missing, i) => {
      if (!missing) return;
      const x = scales.x.getPixelForValue(i);
      if (!Number.isFinite(x)) return;
      const w = 6;
      const h = 10;
      const y = chartArea.bottom - h - 2;
      ctx.save();
      ctx.beginPath();
      ctx.roundRect(x - w / 2, y, w, h, 3);
      ctx.fillStyle = hatchPattern(chart, 'rgba(148, 163, 184, 0.55)');
      ctx.fill();
      ctx.strokeStyle = 'rgba(148, 163, 184, 0.45)';
      ctx.lineWidth = 1;
      ctx.stroke();
      ctx.restore();
    });
  },
};
Chart.register(missingStagePlugin);

const renderSleepChart = () => {
  const rows = state.rangeRows;
  const stages = [
    { key: 'deep', label: '深睡', color: C.indigo },
    { key: 'light', label: '浅睡', color: C.sky },
    { key: 'rem', label: 'REM', color: C.purple },
    { key: 'awake', label: '清醒', color: C.rose },
  ];
  const chart = makeChart('sleepChart', {
    type: 'bar',
    data: {
      labels: rows.map(shortDate),
      datasets: [
        ...stages.map((st) => ({
          label: st.label,
          data: rows.map((r) => r[st.key]),
          backgroundColor: barFill(st.color, 0.92, 0.55),
          borderColor: 'rgba(9, 10, 15, 0.55)',
          borderWidth: { top: 1, left: 0, right: 0, bottom: 0 },
          borderRadius: 4,
          borderSkipped: false,
          stack: 'sleep',
          barPercentage: 0.72,
          categoryPercentage: 0.82,
        })),
        {
          label: '总时长（线）',
          data: rows.map((r) => r.sleep_total_min),
          type: 'line',
          borderColor: C.line,
          backgroundColor: 'transparent',
          borderWidth: 2,
          borderDash: [5, 5],
          cubicInterpolationMode: 'monotone',
          pointRadius: 0,
          pointHoverRadius: 4,
          pointHoverBackgroundColor: '#07090d',
          pointHoverBorderColor: C.line,
        },
      ],
    },
    options: withLegend(chartOptions('分钟', { scales: baseScales('分钟', true) })),
  });
  if (chart) {
    chart.$missingStages = rows.map(
      (r) => r.stage_completeness != null && r.stage_completeness < 1 && r.deep == null
    );
  }
};

// series 数组长度 === data.daily 全长度；range 始终 tail-slice ⇒ 全局 index 有固定偏移
const toGlobal = (i) => state.data.daily.length - state.rangeRows.length + i;

const renderHrvChart = () => {
  const s = state.data.series.hrv;
  const rows = state.rangeRows;
  // amber segments where HRV sits below its own 28-day baseline - 1 SD
  const band = baselineBand(state.data.daily.map((r) => r.hrv_avg));
  const start = state.data.daily.indexOf(rows[0]);
  const lowFlags = rows.map((_, i) => {
    const idx = start + i;
    const v = rows[i].hrv_avg;
    const lo = band.lower[idx];
    return v != null && lo != null && v < lo;
  });
  makeChart('hrvChart', {
    type: 'line',
    data: {
      labels: rows.map(shortDate),
      datasets: [
        ...corridorDatasets(rows, 'hrv_avg'),
        lineDataset('单日 HRV', (r) => r.hrv_avg, C.emerald, {
          fill: true,
          backgroundColor: areaFill(C.emerald, 0.3),
          segment: {
            borderColor: (ctx) =>
              lowFlags[ctx.p0DataIndex] && lowFlags[ctx.p1DataIndex] ? C.amber : C.emerald,
          },
        }),
        lineDataset('7 天均值', () => null, '#e2e8f0', {
          borderWidth: 1.4,
          backgroundColor: 'transparent',
          data: rows.map((_, i) => s.mean_7d[toGlobal(i)]),
        }),
        lineDataset('28 天基线', () => null, C.lineDim, {
          borderDash: [4, 4],
          borderWidth: 1.4,
          backgroundColor: 'transparent',
          data: rows.map((_, i) => s.mean_28d[toGlobal(i)]),
        }),
        lineDataset('设备基线', () => null, C.slate, {
          borderDash: [2, 4],
          borderWidth: 1,
          backgroundColor: 'transparent',
          data: rows.map((_, i) => s.device_baseline[toGlobal(i)]),
        }),
      ],
    },
    options: withLegend(chartOptions('ms')),
  });
};

const renderRhrChart = () => {
  const s = state.data.series.rhr;
  const rows = state.rangeRows;
  makeChart('rhrChart', {
    type: 'line',
    data: {
      labels: rows.map(shortDate),
      datasets: [
        ...corridorDatasets(rows, 'rhr'),
        lineDataset('单日', (r) => r.rhr, C.rose, {
          fill: true,
          backgroundColor: areaFill(C.rose, 0.26),
        }),
        lineDataset('7 天均值', () => null, '#e2e8f0', {
          borderWidth: 1.4,
          backgroundColor: 'transparent',
          data: rows.map((_, i) => s.mean_7d[toGlobal(i)]),
        }),
        lineDataset('28 天基线', () => null, C.lineDim, {
          borderDash: [4, 4],
          borderWidth: 1.4,
          backgroundColor: 'transparent',
          data: rows.map((_, i) => s.mean_28d[toGlobal(i)]),
        }),
      ],
    },
    options: withLegend(chartOptions('bpm')),
  });
};

const renderStressChart = () => {
  const s = state.data.series.stress_avg;
  const rows = state.rangeRows;
  makeChart('stressChart', {
    type: 'line',
    data: {
      labels: rows.map(shortDate),
      datasets: [
        ...corridorDatasets(rows, 'stress_avg'),
        lineDataset('平均压力', (r) => r.stress_avg, C.amber, {
          fill: true,
          backgroundColor: areaFill(C.amber, 0.26),
        }),
        lineDataset('7 天均值', () => null, '#e2e8f0', {
          borderWidth: 1.4,
          backgroundColor: 'transparent',
          data: rows.map((_, i) => s.mean_7d[toGlobal(i)]),
        }),
      ],
    },
    options: withLegend(chartOptions('分')),
  });
};

const renderStepsChart = () => {
  const rows = state.rangeRows;
  makeChart('stepsChart', {
    type: 'bar',
    data: {
      labels: rows.map(shortDate),
      datasets: [
        ...corridorDatasets(rows, 'steps'),
        {
          label: '步数',
          data: rows.map((r) => r.steps),
          backgroundColor: barFill(C.cyan, 0.9, 0.28),
          hoverBackgroundColor: C.cyan,
          borderRadius: 4,
          borderSkipped: false,
          barPercentage: 0.72,
          categoryPercentage: 0.86,
        },
      ],
    },
    options: withLegend(chartOptions('步')),
  });
};

const renderLoadCharts = () => {
  const rows = state.rangeRows;
  makeChart('loadChart', {
    type: 'line',
    data: {
      labels: rows.map(shortDate),
      datasets: [
        lineDataset('短期负荷（7 天）', (r) => r.load_short, C.cyan, {
          fill: true,
          backgroundColor: areaFill(C.cyan, 0.24),
        }),
        lineDataset('长期负荷（28 天）', (r) => r.load_long, C.periwinkle, {
          borderDash: [5, 4],
          backgroundColor: 'transparent',
        }),
      ],
    },
    options: withLegend(chartOptions('负荷', { $unit: '' })),
  });

  makeChart('loadRatioChart', {
    type: 'line',
    data: {
      labels: rows.map(shortDate),
      datasets: [
        {
          label: '负荷比',
          data: rows.map((r) => r.load_ratio),
          borderColor: C.amber,
          backgroundColor: areaFill(C.amber, 0.22),
          borderWidth: 2.2,
          cubicInterpolationMode: 'monotone',
          fill: true,
          pointRadius: 0,
          pointHoverRadius: 5,
          pointHoverBackgroundColor: '#07090d',
          pointHoverBorderColor: C.amber,
          segment: {
            borderColor: (ctx) =>
              ctx.p0.parsed.y > 1.2 || ctx.p1.parsed.y > 1.2 ? C.rose : C.amber,
          },
        },
        {
          label: '参考线 1.0',
          data: rows.map(() => 1),
          borderColor: 'rgba(148, 163, 184, 0.45)',
          borderWidth: 1,
          borderDash: [4, 4],
          pointRadius: 0,
          fill: false,
        },
      ],
    },
    options: withLegend(chartOptions('负荷比')),
  });
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
  renderTrainingChart();
  renderProfilePills();
  renderExecutiveSummary();
  renderBodyCharts();
  renderCorrChart();
  renderCorrBuckets();
  renderCorrStats();
  renderHeatmap();
  renderDayDetail();
  renderDailyTable();
  renderQuality();
  renderCoverage();
  renderStatus();
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


// Quantile buckets: a global Pearson r can hide a threshold effect, so the same
// pairs are split by tercile of X (P25 / P75) and Y is compared across groups.
// This is still a descriptive description of *this* window's sample — the
// cut-points are this person's own quantiles, never population thresholds.
const quantile = (sorted, q) => {
  if (!sorted.length) return null;
  const pos = (sorted.length - 1) * q;
  const base = Math.floor(pos);
  const rest = pos - base;
  const next = sorted[base + 1];
  if (next === undefined) return sorted[base];
  return sorted[base] + rest * (next - sorted[base]);
};

const bucketStats = (pairs) => {
  if (pairs.length < 12) return { reason: '样本不足 12 对，暂不分档' };
  const xs = pairs.map((p) => p.x).slice().sort((a, b) => a - b);
  const p25 = quantile(xs, 0.25);
  const p75 = quantile(xs, 0.75);
  if (p75 - p25 < 1e-9) return { reason: '当前窗口内自变量几乎不变，无法分档' };
  const defs = [
    { key: 'low', label: '低位组', rule: `< P25`, test: (p) => p.x < p25 },
    { key: 'mid', label: '常态组', rule: 'P25–P75', test: (p) => p.x >= p25 && p.x <= p75 },
    { key: 'high', label: '高位组', rule: '> P75', test: (p) => p.x > p75 },
  ];
  const groups = defs.map((d) => {
    const ys = pairs.filter(d.test).map((p) => p.y).sort((a, b) => a - b);
    const n = ys.length;
    const mean = n ? ys.reduce((a, b) => a + b, 0) / n : null;
    return { ...d, n, mean, median: n ? quantile(ys, 0.5) : null };
  });
  const lo = groups[0];
  const hi = groups[2];
  const deltaMean = lo.mean != null && hi.mean != null ? hi.mean - lo.mean : null;
  const deltaMedian =
    lo.median != null && hi.median != null ? hi.median - lo.median : null;
  return { p25, p75, groups, deltaMean, deltaMedian };
};

const renderCorrBuckets = () => {
  const box = document.getElementById('corr-buckets');
  if (!box) return;
  const { def, pairs } = corrPairs();
  const b = bucketStats(pairs);
  const sign = (v) => (v > 0 ? '+' : '');
  const fx = (v) => (v == null ? '—' : num(v, 1));
  const fy = (v) => (v == null ? '—' : num(v, 1));

  if (b.reason) {
    box.innerHTML = `
      <div class="bucket-head"><h4>分位数对比</h4></div>
      <p class="bucket-empty">${b.reason}</p>`;
    return;
  }

  const means = b.groups.map((g) => g.mean).filter((v) => v != null);
  const lo = Math.min(...means);
  const hi = Math.max(...means);
  const span = hi - lo || 1;
  const bars = b.groups
    .map((g) => {
      const w = g.mean == null ? 0 : 18 + ((g.mean - lo) / span) * 82;
      return `<div class="bucket-row">
        <span class="bucket-label">${g.label}<small>${g.rule}</small></span>
        <span class="bucket-bar"><i class="b-${g.key}" style="width:${w.toFixed(1)}%"></i></span>
        <span class="bucket-val">${fy(g.mean)}<small>n=${g.n}</small></span>
      </div>`;
    })
    .join('');

  const lead =
    b.deltaMean == null
      ? '分档样本不足以比较。'
      : `当${def.label.split('→')[0].trim()}处于最低 25%（< ${fx(b.p25)} ${def.xu}）时，${def.label.split('→')[1].trim()} 均值为 ${fy(b.groups[0].mean)} ${def.yu}；高于 75%（> ${fx(b.p75)} ${def.xu}）时为 ${fy(b.groups[2].mean)} ${def.yu}，相差 ${sign(b.deltaMean)}${fx(b.deltaMean)} ${def.yu}${
          b.deltaMedian == null ? '' : `（中位数差 ${sign(b.deltaMedian)}${fx(b.deltaMedian)} ${def.yu}）`
        }。`;

  box.innerHTML = `
    <div class="bucket-head">
      <h4>分位数对比</h4>
      <span class="hint">分位点取自当前窗口样本（滞后 ${state.corrLag} 天）</span>
    </div>
    <p class="bucket-lead">${lead}</p>
    <div class="bucket-bars">${bars}</div>
    <table class="coverage bucket-table">
      <thead><tr><th>组</th><th>n</th><th>${def.yu} 均值</th><th>中位数</th></tr></thead>
      <tbody>${b.groups
        .map(
          (g) => `<tr><td>${g.label}（${g.rule}）</td><td class="num">${g.n}</td>
            <td class="num">${fy(g.mean)}</td><td class="num">${fy(g.median)}</td></tr>`
        )
        .join('')}</tbody>
    </table>
    <p class="bucket-note">分档只说明「本窗口内 X 高低两端的 Y 是否不同」，不构成阈值建议；样本少或存在趋势时结论不稳，切换时间范围复看。</p>`;
};

const renderCorrChart = () => {
  const { def, pairs } = corrPairs();
  const st = pearsonJs(pairs);
  const fit = (() => {
    if (st.r === null || pairs.length < 2) return null;
    const xs = pairs.map((p) => p.x);
    const ys = pairs.map((p) => p.y);
    const mx = xs.reduce((a, b) => a + b, 0) / xs.length;
    const my = ys.reduce((a, b) => a + b, 0) / ys.length;
    const denom = pairs.reduce((a, p) => a + (p.x - mx) ** 2, 0);
    if (!denom) return null;
    const slope = pairs.reduce((a, p) => a + (p.x - mx) * (p.y - my), 0) / denom;
    const a = my - slope * mx;
    const xmin = Math.min(...xs);
    const xmax = Math.max(...xs);
    return [
      { x: xmin, y: a + slope * xmin },
      { x: xmax, y: a + slope * xmax },
    ];
  })();

  makeChart('corrChart', {
    type: 'scatter',
    data: {
      datasets: [
        {
          label: def.label,
          data: pairs.map((p) => ({ x: p.x, y: p.y, date: p.date })),
          backgroundColor: 'rgba(56, 189, 248, 0.55)',
          borderColor: C.sky,
          borderWidth: 1,
          pointRadius: 3.4,
          pointHoverRadius: 6,
          pointHoverBackgroundColor: '#07090d',
          pointHoverBorderWidth: 2,
        },
        ...(fit
          ? [
              {
                label: `线性拟合 r=${st.r.toFixed(2)}`,
                type: 'line',
                data: fit,
                borderColor: 'rgba(226, 232, 240, 0.55)',
                borderWidth: 1.5,
                borderDash: [5, 5],
                pointRadius: 0,
                fill: false,
              },
            ]
          : []),
      ],
    },
    options: {
      ...chartOptions(''),
      scales: {
        x: {
          type: 'linear',
          grid: { color: C.grid, borderDash: [3, 3], drawTicks: false },
          border: { display: false },
          ticks: axisTicks(6),
          title: {
            display: true,
            text: `${def.label.split('→')[0].trim()}（${def.xu}）`,
            color: '#475569',
            font: { family: MONO, size: 10 },
          },
        },
        y: {
          grid: { color: C.grid, borderDash: [3, 3], drawTicks: false },
          border: { display: false },
          ticks: axisTicks(5),
          title: {
            display: true,
            text: `${def.label.split('→')[1].trim()}（${def.yu}）`,
            color: '#475569',
            font: { family: MONO, size: 10 },
          },
        },
      },
      plugins: { legend: { display: false } },
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
  // Monday-first weekday index, used to pad each month's grid so the same
  // weekday always sits in the same column across months.
  const weekday = (date) => (new Date(date + 'T00:00:00').getDay() + 6) % 7;

  const months = new Map();
  for (const r of all) {
    if (r.date < addDays(all.at(-1).date, -400)) continue;
    const monthKey = r.date.slice(0, 7);
    if (!months.has(monthKey)) months.set(monthKey, []);
    months.get(monthKey).push(r);
  }
  const monthBlocks = [...months.entries()]
    .map(([month, rows]) => {
      const pad = weekday(rows[0].date);
      const cells =
        Array.from({ length: pad }, () => '<span class="hblank" aria-hidden="true"></span>').join('') +
        rows
          .map((r) => {
            const v = r[state.heat];
            const ratio = defRank(v);
            const hasData = v !== null && v !== undefined;
            return `<button type="button" class="hcell${hasData ? '' : ' nodata'}${r.date === selectedDate() ? ' sel' : ''}"
              data-date="${r.date}" style="--v:${ratio}"
              aria-label="${r.date} ${m.label} ${hasData ? m.fmt(v) : '无数据'}"
              title="${r.date} · ${hasData ? m.fmt(v) : '无数据'}">${Number(r.date.slice(8))}</button>`;
          })
          .join('');
      return `<div class="hmonth">
        <div class="hmonth-title">${month}</div>
        <div class="hweek" aria-hidden="true">${['一', '二', '三', '四', '五', '六', '日']
          .map((d) => `<span>${d}</span>`)
          .join('')}</div>
        <div class="hgrid">${cells}</div>
      </div>`;
    })
    .join('');

  const span = nums.length
    ? hi >= 1000
      ? `${num(lo)} – ${num(hi)}`
      : `${num(lo, 1)} – ${num(hi, 1)}`
    : '—';
  const legend = `<div class="heat-legend">
    <span class="heat-legend-unit">${m.label}（${m.unit || '值'}）</span>
    <span class="heat-legend-scale" aria-hidden="true"><i class="lo"></i><i class="mid"></i><i class="hi"></i></span>
    <span class="heat-legend-span">${span}</span>
    <span class="heat-legend-gap"><i class="nodata-swatch" aria-hidden="true"></i>无数据（不是 0）</span>
  </div>`;

  container.innerHTML = `<div class="heat-months">${monthBlocks}</div>${legend}`;
};

const selectedDate = () => state.selectedDate || null;


// ±3 day mini context: training / sleep / recovery side by side, so a spike in
// one metric can be read against what happened on the neighbouring days.
const contextTable = (date) => {
  const rows = state.data.daily;
  const acts = state.data.activities_recent || [];
  const cells = [];
  for (let d = -3; d <= 3; d++) {
    const day = addDays(date, d);
    const r = rows.find((x) => x.date === day);
    const sport = acts
      .filter((a) => a.date === day)
      .map((a) => `${a.sport}${a.distance_km ? ` ${num(a.distance_km, 1)}km` : ''}`)
      .join('、');
    const v = (x, digits = 0) => (x == null ? '缺失' : num(x, digits));
    cells.push(`<tr class="${d === 0 ? 'ctx-today' : ''}">
      <td class="ctx-date">${day.slice(5)}${d === 0 ? ' <span class="ctx-mark">当天</span>' : ''}</td>
      <td>${hmin(r?.sleep_total_min)}</td>
      <td>${v(r?.hrv_avg)}</td>
      <td>${v(r?.rhr)}</td>
      <td>${v(r?.stress_avg)}</td>
      <td>${v(r?.steps)}</td>
      <td>${r?.load_ratio == null ? '缺失' : num(r.load_ratio, 2)}</td>
      <td class="ctx-sport">${sport || '—'}</td>
    </tr>`);
  }
  return `<div class="ctx-wrap">
    <div class="ctx-head"><b>前后 3 天上下文</b>
      <span class="hint">睡眠=醒来日 · 其余为自然日 · 缺失不补 0</span></div>
    <div class="table-wrap"><table class="coverage ctx-table">
      <thead><tr><th>日期</th><th>睡眠</th><th>HRV</th><th>静息</th><th>压力</th><th>步数</th><th>负荷比</th><th>训练</th></tr></thead>
      <tbody>${cells.join('')}</tbody>
    </table></div>
  </div>`;
};

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
    </div>
    ${contextTable(date)}`;
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
  // trailing 28-day SD of HRV, so a deviation can be expressed in SD units
  // (same ±1.5 SD rule as the executive summary, not an invented threshold)
  const band = baselineBand(state.data.daily.map((r) => r.hrv_avg));
  const hrvSd = (r) => {
    const i = allIdx(r);
    if (i < 0 || band.upper[i] == null || band.lower[i] == null) return null;
    const sd = (band.upper[i] - band.lower[i]) / 2;
    return sd > 0 ? sd : null;
  };

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
          const sd = hrvSd(r);
          const d = dev(r);
          const z = sd != null && d != null ? d / sd : null;
          const hrvCls =
            z == null ? '' : z <= -1.5 ? ' cell-warn' : z >= 1.5 ? ' cell-good' : '';
          const ratio = r.load_ratio;
          const loadCls =
            ratio == null ? '' : ratio > 1.2 ? ' cell-warn' : ratio < 0.8 ? ' cell-dim' : '';
          const cellCls = (k) =>
            k === 'deviation_hrv' ? hrvCls : k === 'load_ratio' ? loadCls : '';
          const cellTitle = (k) =>
            k === 'deviation_hrv' && z != null
              ? ` title="相对 28 天基线的 ${z > 0 ? '+' : ''}${z.toFixed(1)} SD"`
              : k === 'load_ratio' && r.load_comment
                ? ` title="${r.load_comment}"`
                : '';
          return `<tr><td class="col-date">${vals.date}</td>${DAILY_COLS.slice(1)
            .map(
              ([k]) =>
                `<td class="num${cellCls(k)}"${cellTitle(k)}>${vals[k]}</td>`
            )
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
  if (id === 'trainingChart') {
    const start = rangeStartDate();
    const weeks = (state.data.training || []).filter((w) => !start || w.week >= start);
    return `<table class="coverage table-inline">
      <thead><tr><th>周（周一）</th><th>跑步次</th><th>跑步 km</th><th>骑行次</th><th>骑行 km</th><th>总时长</th></tr></thead>
      <tbody>${weeks
        .slice(-120)
        .reverse()
        .map((w) => `<tr><td>${w.week}</td><td class="num">${w.runs}</td><td class="num">${num(w.run_km, 1)}</td><td class="num">${w.rides}</td><td class="num">${num(w.ride_km, 1)}</td><td class="num">${Math.round(w.minutes)} min</td></tr>`)
        .join('')}</tbody>
      <caption>共 ${weeks.length} 周；只列出当前时间范围内有记录的周</caption>
    </table>`;
  }
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
  state.customRange = null;
  const note = document.getElementById('custom-range-note');
  if (note) note.textContent = '';
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
  const label = state.customRange
    ? `${state.customRange.start} → ${state.customRange.end}`
    : n === 0
      ? '全部历史'
      : `最近 ${n} 天`;
  const rangeLabel = document.getElementById('range-label');
  if (rangeLabel) rangeLabel.textContent = `时间范围：${label}`;
  const windowLabel = document.getElementById('window-label');
  if (windowLabel) {
    windowLabel.innerHTML = `<span class="wl-prefix">当前窗口：</span>${label}`;
  }
  document.getElementById('sticky-bar')?.classList.toggle('is-custom', !!state.customRange);
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


// Section nav: highlight the section currently under the sticky bar.
const initSectionSpy = () => {
  const links = [...document.querySelectorAll('.section-nav a[href^="#"]')];
  if (!links.length) return;
  const targets = links
    .map((a) => ({ link: a, section: document.querySelector(a.getAttribute('href')) }))
    .filter((t) => t.section);
  let frame = 0;
  const update = () => {
    frame = 0;
    const line = (document.getElementById('sticky-bar')?.getBoundingClientRect().bottom || 0) + 24;
    let current = targets[0];
    for (const t of targets) {
      if (t.section.getBoundingClientRect().top <= line) current = t;
    }
    for (const t of targets) {
      if (t === current) t.link.setAttribute('aria-current', 'true');
      else t.link.removeAttribute('aria-current');
    }
  };
  window.addEventListener(
    'scroll',
    () => {
      if (!frame) frame = requestAnimationFrame(update);
    },
    { passive: true }
  );
  update();
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
    // only preset buttons carry data-range; the custom toggle must not reset it
    const btn = e.target.closest('button[data-range]');
    if (btn && Number.isFinite(Number(btn.dataset.range))) {
      applyRange(Number(btn.dataset.range));
    }
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

  // custom date range
  const customBox = document.getElementById('custom-range');
  const toggle = document.getElementById('custom-toggle');
  const startInput = document.getElementById('range-start');
  const endInput = document.getElementById('range-end');
  const all = state.data.daily;
  if (all.length) {
    startInput.min = endInput.min = all[0].date;
    startInput.max = endInput.max = all[all.length - 1].date;
    startInput.value = all[Math.max(0, all.length - 30)].date;
    endInput.value = all[all.length - 1].date;
  }
  toggle.addEventListener('click', () => {
    const open = customBox.hidden;
    customBox.hidden = !open;
    toggle.setAttribute('aria-expanded', String(open));
    if (open) startInput.focus();
  });
  document.getElementById('range-apply').addEventListener('click', () => {
    const start = startInput.value;
    const end = endInput.value;
    const note = document.getElementById('custom-range-note');
    if (!start || !end) {
      note.textContent = '请选择开始和结束日期';
      return;
    }
    if (start > end) {
      note.textContent = '开始日期不能晚于结束日期';
      return;
    }
    const rows = state.data.daily.filter((r) => r.date >= start && r.date <= end);
    if (!rows.length) {
      note.textContent = '该区间没有记录';
      return;
    }
    note.textContent = `${rows.length} 天有记录`;
    state.customRange = { start, end };
    document.querySelectorAll('#range button[data-range]').forEach((b) => {
      b.classList.remove('active');
      b.setAttribute('aria-pressed', 'false');
    });
    const rangeLabel = document.getElementById('range-label');
    if (rangeLabel) rangeLabel.textContent = `时间范围：${start} → ${end}`;
    const windowLabel = document.getElementById('window-label');
    if (windowLabel) {
      windowLabel.innerHTML = `<span class="wl-prefix">当前窗口：</span>${start} → ${end}`;
    }
    document.getElementById('sticky-bar')?.classList.add('is-custom');
    renderCharts();
  });

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
  initSectionSpy();

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

init().catch((error) => {
  console.error(error);
  showFatal('初始化失败：' + error.message);
});
