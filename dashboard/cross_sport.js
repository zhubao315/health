/* Cross-sport panel: reads the aggregate index only (dashboard/cross_sport.json).
   Never invents a value: a field the devices did not record is rendered as "—". */
(function () {
  const SPORTS = [
    { key: 'running', label: '跑步', color: 'var(--accent)' },
    { key: 'cycling', label: '骑行', color: 'var(--amber)' },
    { key: 'hiking', label: '徒步', color: 'var(--ok)' },
  ];

  const root = () => document.getElementById('cross-sport-root');
  const hint = () => document.getElementById('cross-sport-updated');

  const num = (v, digits = 0) =>
    v === null || v === undefined || Number.isNaN(Number(v))
      ? '—'
      : Number(v).toLocaleString('zh-CN', {
          minimumFractionDigits: digits,
          maximumFractionDigits: digits,
        });

  const esc = (s) =>
    String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

  const empty = (msg) => `<p class="empty-state">${esc(msg)}</p>`;

  const careerCard = (sport, bucket, career) => {
    const share =
      career && career.duration_h ? ((bucket.duration_h / career.duration_h) * 100).toFixed(1) : null;
    return `<article class="xs-card">
      <div class="xs-card-head"><span class="xs-dot" style="background:${sport.color}"></span>${sport.label}</div>
      <div class="xs-num">${num(bucket.count)}<small>次</small></div>
      <dl class="xs-list">
        <div><dt>距离</dt><dd>${num(bucket.distance_km, 1)} km</dd></div>
        <div><dt>时长</dt><dd>${num(bucket.duration_h, 1)} h</dd></div>
        <div><dt>爬升</dt><dd>${bucket.elevation_records ? `${num(bucket.elevation_gain_m)} m <em>${bucket.elevation_records} 条有记录</em>` : '设备未记录'}</dd></div>
        <div><dt>心率</dt><dd>${bucket.hr_records ? `${num(bucket.hr_records)} 条有记录` : '设备未记录'}</dd></div>
      </dl>
      ${share === null ? '' : `<div class="xs-share"><span style="width:${share}%;background:${sport.color}"></span></div><div class="xs-share-label">占跨项目总时长 ${share}%</div>`}
    </article>`;
  };

  const yearTable = (data, sortKey, sortDir) => {
    const rows = data.years.map((y) => ({
      year: y.year,
      totals: y.totals,
      sports: y.sports,
    }));
    const getVal = (row, key) => {
      if (key === 'year') return row.year;
      if (key === 'duration') return row.totals.duration_h;
      if (key === 'elevation') return row.totals.elevation_gain_m ?? -1;
      if (key === 'count') return row.totals.count;
      return row.sports[key] ? row.sports[key].distance_km : -1;
    };
    rows.sort((a, b) => (getVal(a, sortKey) - getVal(b, sortKey)) * (sortDir === 'asc' ? 1 : -1));

    const head = (key, label) =>
      `<th data-sort="${key}" class="${sortKey === key ? 'xs-sorted' : ''}">${label}${
        sortKey === key ? (sortDir === 'asc' ? ' ↑' : ' ↓') : ''
      }</th>`;

    const body = rows
      .map((row) => {
        const totalHours = row.totals.duration_h || 0;
        const bars = SPORTS.map((s) => {
          const h = row.sports[s.key]?.duration_h || 0;
          const pct = totalHours ? (h / totalHours) * 100 : 0;
          return pct
            ? `<span style="width:${pct}%;background:${s.color}" title="${s.label} ${pct.toFixed(1)}%"></span>`
            : '';
        }).join('');
        return `<tr>
          <td>${row.year}</td>
          ${SPORTS.map((s) => {
            const b = row.sports[s.key] || {};
            return `<td><strong>${num(b.distance_km, 1)}</strong><em>${num(b.count)} 次</em></td>`;
          }).join('')}
          <td>${num(row.totals.duration_h, 1)} h</td>
          <td>${row.totals.elevation_gain_m === null || row.totals.elevation_gain_m === undefined ? '—' : `${num(row.totals.elevation_gain_m)} m`}</td>
          <td class="xs-share-cell"><div class="xs-share">${bars}</div></td>
        </tr>`;
      })
      .join('');

    return `<div class="table-wrap"><table class="coverage xs-year-table">
      <thead><tr>
        ${head('year', '年份')}
        ${SPORTS.map((s) => head(s.key, `${s.label} · km`)).join('')}
        ${head('duration', '总时长')}
        ${head('elevation', '累计爬升')}
        <th>时长占比</th>
      </tr></thead>
      <tbody>${body}</tbody>
    </table></div>
    <p class="note">总时长与累计爬升可跨项目合计，距离列按项目分列、不相加；爬升只统计真正记录了 elevation_gain 的活动。</p>`;
  };

  const monthChart = (data) => {
    const months = data.recent_months || [];
    if (!months.length) return empty('暂无月度分布数据');
    const max = Math.max(...months.map((m) => m.running + m.cycling + m.hiking), 1);
    const bars = months
      .map((m) => {
        const total = m.running + m.cycling + m.hiking;
        const seg = (v, color) =>
          v ? `<span style="height:${(v / max) * 100}%;background:${color}" title="${v} 次"></span>` : '';
        return `<div class="xs-month" title="${m.month}：跑步 ${m.running} / 骑行 ${m.cycling} / 徒步 ${m.hiking}">
          <div class="xs-month-stack">
            ${seg(m.running, 'var(--accent)')}${seg(m.cycling, 'var(--amber)')}${seg(m.hiking, 'var(--ok)')}
          </div>
          <span>${m.month}</span>
          <em>${total ? total : ''}</em>
        </div>`;
      })
      .join('');
    return `<div class="xs-months">${bars}</div>
      <p class="note">最近 ${months.length} 个月的次数分布（堆叠高度 = 三类合计次数），仅统计有开始时间、距离与时长的记录。</p>`;
  };

  const render = (data, sortKey = 'year', sortDir = 'desc') => {
    const host = root();
    if (!host) return;
    if (!data || !data.career) {
      host.innerHTML = empty('跨运动汇总暂时不可用；其他模块不受影响。');
      return;
    }
    const career = data.career;
    const careerTotalHours = SPORTS.reduce((a, s) => a + (career[s.key]?.duration_h || 0), 0);
    const cardHtml = SPORTS.map((s) =>
      careerCard(s, career[s.key] || {}, { duration_h: careerTotalHours })
    ).join('');

    const sourceNote = (data.sources || [])
      .map((s) => `${s.sport === 'running' ? '跑步' : s.sport === 'cycling' ? '骑行' : '徒步'} ${num(s.records_used)} 条（源：${esc(s.repo)}）`)
      .join(' · ');

    host.innerHTML = `
      <div class="xs-career">${cardHtml}</div>
      <article class="card wide xs-block">
        <div class="card-head">
          <h3>年度跨运动统计</h3>
          <span class="hint">可点击表头排序</span>
        </div>
        ${yearTable(data, sortKey, sortDir)}
      </article>
      <article class="card wide xs-block">
        <div class="card-head">
          <h3>月度分布</h3>
          <span class="hint">跑步 / 骑行 / 徒步</span>
        </div>
        ${monthChart(data)}
      </article>
      <p class="note xs-source">数据来源：${sourceNote}；生成时间 ${esc(String(data.generated_at || '').replace('T', ' ').slice(0, 19))} UTC。</p>`;

    host.querySelectorAll('th[data-sort]').forEach((th) => {
      th.addEventListener('click', () => {
        const key = th.dataset.sort;
        const dir = sortKey === key && sortDir === 'desc' ? 'asc' : 'desc';
        render(data, key, dir);
      });
    });

    if (hint()) hint().textContent = `${SPORTS.length} 个项目 · 年度汇总 · 距离不混加`;
  };

  const load = () => {
    fetch('./cross_sport.json', { cache: 'no-store' })
      .then((r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return r.json();
      })
      .then((data) => render(data))
      .catch((err) => {
        const host = root();
        if (host) host.innerHTML = empty(`跨运动汇总加载失败（${err.message}）；其他模块不受影响。`);
        console.warn('cross-sport unavailable', err);
      });
  };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', load);
  } else {
    load();
  }
})();
