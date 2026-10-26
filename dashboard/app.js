const ACCENT = '#22d3ee';
const ACCENT_2 = '#38bdf8';
const RED = '#fb7185';
const AMBER = '#fbbf24';
const VIOLET = '#a78bfa';

const chartDefaults = () => {
  Chart.defaults.color = '#93a1b3';
  Chart.defaults.borderColor = 'rgba(255,255,255,0.06)';
  Chart.defaults.font.family =
    "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'PingFang SC', sans-serif";
  Chart.defaults.font.size = 11;
};

const charts = {};
const makeChart = (id, config) => {
  if (charts[id]) charts[id].destroy();
  charts[id] = new Chart(document.getElementById(id), config);
};

const hmin = (minutes) => {
  if (minutes === null || minutes === undefined) return '—';
  const h = Math.floor(minutes / 60);
  const m = Math.round(minutes % 60);
  return h ? `${h}h ${String(m).padStart(2, '0')}m` : `${m}m`;
};

const num = (value, digits = 0) => {
  if (value === null || value === undefined) return '—';
  return Number(value).toLocaleString('en-US', {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  });
};

let data = null;
let rows = [];
let range = 90;

const filterRows = () => {
  if (!data) return [];
  const all = data.daily;
  return range > 0 ? all.slice(-range) : all;
};

const labels = () => rows.map((r) => r.date.slice(5));

const buildKpis = () => {
  const latest = data.latest;
  const snap = data.snapshot || {};
  const recovery = snap.recovery || {};
  const fitness = snap.fitness || {};
  const kpis = [
    {
      value: hmin(latest.sleep_total_min.value),
      label: '最近睡眠',
      sub: latest.sleep_score.value ? `睡眠分 ${latest.sleep_score.value}` : '',
    },
    {
      value: latest.hrv_avg.value === null ? '—' : `${latest.hrv_avg.value} ms`,
      label: 'HRV',
      sub: latest.hrv_baseline.value ? `基线 ${latest.hrv_baseline.value} ms` : '',
    },
    {
      value: latest.rhr.value === null ? '—' : `${latest.rhr.value} bpm`,
      label: '静息心率',
      sub: latest.avg_hr.value ? `日均 ${latest.avg_hr.value} bpm` : '',
    },
    {
      value: latest.stress_avg.value === null ? '—' : latest.stress_avg.value,
      label: '平均压力',
      sub: latest.steps.value ? `${num(latest.steps.value)} 步` : '',
    },
    {
      value: latest.load_ratio.value === null ? '—' : num(latest.load_ratio.value, 2),
      label: '负荷比',
      sub: latest.load_short.value
        ? `短期 ${latest.load_short.value} / 长期 ${latest.load_long.value}`
        : '',
    },
    {
      value: recovery.recovery_pct === undefined ? '—' : `${recovery.recovery_pct}%`,
      label: '恢复',
      sub: recovery.recovery_level || '',
    },
    {
      value: fitness.vo2max === undefined ? '—' : fitness.vo2max,
      label: 'VO2max',
      sub: fitness.threshold_pace || '',
    },
    {
      value: num(latest.steps.value),
      label: '步数',
      sub: latest.exercise_min.value ? `运动 ${latest.exercise_min.value} 分钟` : '',
    },
  ];
  document.getElementById('kpis').innerHTML = kpis
    .map(
      (k) => `
      <div class="kpi">
        <span class="value">${k.value}</span>
        <span class="label">${k.label}</span>
        <span class="sub">${k.sub || '&nbsp;'}</span>
      </div>`
    )
    .join('');
};

const line = (label, key, color, extra = {}) => ({
  label,
  data: rows.map((r) => r[key]),
  borderColor: color,
  backgroundColor: color,
  borderWidth: 2,
  pointRadius: 0,
  pointHoverRadius: 4,
  tension: 0.28,
  spanGaps: true,
  ...extra,
});

const baseScales = () => ({
  x: {
    grid: { display: false },
    ticks: { maxRotation: 0, autoSkip: true, maxTicksLimit: 12 },
  },
  y: {
    grid: { color: 'rgba(255,255,255,0.06)' },
    ticks: { maxTicksLimit: 6 },
  },
});

const chartOptions = (unit) => ({
  responsive: true,
  maintainAspectRatio: false,
  interaction: { mode: 'index', intersect: false },
  plugins: { legend: { display: false } },
  scales: {
    ...baseScales(),
    y: {
      ...baseScales().y,
      title: { display: !!unit, text: unit, color: '#93a1b3' },
    },
  },
});

const renderCharts = () => {
  rows = filterRows();
  const x = labels();

  const sleepData = rows.map((r) => {
    const total = r.sleep_total_min;
    const pick = (min, pct) => {
      if (min !== null && min !== undefined) return min;
      if (total && pct) return Math.round((total * pct) / 100);
      return 0;
    };
    return {
      deep: pick(r.sleep_deep_min, r.deep_pct),
      light: pick(r.sleep_light_min, r.light_pct),
      rem: pick(r.sleep_rem_min, r.rem_pct),
      awake: pick(r.sleep_awake_min, r.awake_pct),
    };
  });

  makeChart('sleepChart', {
    type: 'bar',
    data: {
      labels: x,
      datasets: [
        { label: '深睡', data: sleepData.map((d) => d.deep), backgroundColor: '#0e7490', stack: 's' },
        { label: '浅睡', data: sleepData.map((d) => d.light), backgroundColor: ACCENT, stack: 's' },
        { label: 'REM', data: sleepData.map((d) => d.rem), backgroundColor: VIOLET, stack: 's' },
        { label: '清醒', data: sleepData.map((d) => d.awake), backgroundColor: '#475569', stack: 's' },
      ],
    },
    options: {
      ...chartOptions('分钟'),
      plugins: {
        legend: {
          display: true,
          position: 'bottom',
          labels: { boxWidth: 10, boxHeight: 10, usePointStyle: true },
        },
      },
      scales: { ...chartOptions('分钟').scales, x: { ...baseScales().x, stacked: true }, y: { ...baseScales().y, stacked: true } },
    },
  });

  makeChart('hrvChart', {
    type: 'line',
    data: {
      labels: x,
      datasets: [
        line('HRV', 'hrv_avg', ACCENT, { fill: true, backgroundColor: 'rgba(34,211,238,0.1)' }),
        line('基线', 'hrv_baseline', '#64748b', { borderDash: [5, 5], borderWidth: 1.5 }),
      ],
    },
    options: {
      ...chartOptions('ms'),
      plugins: {
        legend: { display: true, position: 'bottom', labels: { boxWidth: 10, usePointStyle: true } },
      },
    },
  });

  makeChart('rhrChart', {
    type: 'line',
    data: { labels: x, datasets: [line('静息心率', 'rhr', AMBER, { fill: true, backgroundColor: 'rgba(251,191,36,0.08)' })] },
    options: chartOptions('bpm'),
  });

  makeChart('stressChart', {
    type: 'line',
    data: { labels: x, datasets: [line('平均压力', 'stress_avg', RED, { fill: true, backgroundColor: 'rgba(251,113,133,0.08)' })] },
    options: chartOptions('分'),
  });

  makeChart('stepsChart', {
    type: 'bar',
    data: {
      labels: x,
      datasets: [{ label: '步数', data: rows.map((r) => r.steps), backgroundColor: 'rgba(56,189,248,0.55)', borderRadius: 3 }],
    },
    options: chartOptions('步'),
  });

  makeChart('loadChart', {
    type: 'line',
    data: {
      labels: x,
      datasets: [
        line('短期负荷', 'load_short', ACCENT, { fill: false }),
        line('长期负荷', 'load_long', ACCENT_2, { fill: false }),
        line('负荷比', 'load_ratio', AMBER, { borderDash: [4, 4], borderWidth: 1.5, yAxisID: 'y1' }),
      ],
    },
    options: {
      ...chartOptions('负荷'),
      plugins: {
        legend: { display: true, position: 'bottom', labels: { boxWidth: 10, usePointStyle: true } },
      },
      scales: {
        ...baseScales(),
        y: { ...baseScales().y, title: { display: true, text: '负荷', color: '#93a1b3' } },
        y1: {
          position: 'right',
          grid: { drawOnChartArea: false },
          ticks: { maxTicksLimit: 5 },
          title: { display: true, text: '负荷比', color: '#93a1b3' },
        },
      },
    },
  });
};

const renderCorrelations = () => {
  const box = document.getElementById('correlations');
  box.innerHTML = (data.correlations || [])
    .map((c) => {
      const r = c.r === null ? '—' : c.r.toFixed(2);
      const cls = c.r !== null && c.r < 0 ? 'neg' : '';
      return `<div class="corr ${cls}"><div class="r">${r}</div><div class="name">${c.label} · n=${c.n}</div></div>`;
    })
    .join('');
};

const renderCoverage = () => {
  const names = {
    daily_health: '每日健康汇总',
    sleep: '睡眠',
    hrv: 'HRV',
    avg_hr: '日均心率',
    rhr: '静息心率',
    stress_daily: '压力（日）',
    load: '训练负荷',
    activities: '运动记录',
  };
  const rowsHtml = Object.entries(data.coverage || {})
    .map(
      ([key, v]) => `<tr><td>${names[key] || key}</td><td>${v.start || '—'}</td><td>${v.end || '—'}</td><td>${num(v.rows)}</td></tr>`
    )
    .join('');
  document.getElementById('coverage').innerHTML = `
    <thead><tr><th>数据表</th><th>开始</th><th>结束</th><th>行数</th></tr></thead>
    <tbody>${rowsHtml}</tbody>`;
  const stamp = data.generated_at ? new Date(data.generated_at) : null;
  document.getElementById('generated').textContent = stamp
    ? `生成于 ${stamp.toLocaleString('zh-CN')}`
    : '';
};

const render = () => {
  buildKpis();
  renderCharts();
  renderCorrelations();
  renderCoverage();
};

const init = async () => {
  chartDefaults();
  const response = await fetch('./data.json', { cache: 'no-store' });
  data = await response.json();
  rows = filterRows();
  document.getElementById('range').addEventListener('click', (event) => {
    const button = event.target.closest('button');
    if (!button) return;
    range = Number(button.dataset.range);
    document.querySelectorAll('#range button').forEach((b) => b.classList.toggle('active', b === button));
    renderCharts();
  });
  render();
};

init().catch((error) => {
  document.getElementById('kpis').innerHTML = `<div class="kpi"><span class="value">!</span><span class="label">数据加载失败</span><span class="sub">${error.message}</span></div>`;
});
