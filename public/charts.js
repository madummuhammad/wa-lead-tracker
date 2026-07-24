// Minimal, dependency-free SVG chart helpers for the Dashboard page.
// Mark specs follow the project's data-viz guidelines: thin bars (<=24px,
// rounded data-end), 2px lines, hairline gridlines, a legend whenever there
// are 2+ series, selective direct labels, and a hover tooltip on every mark.

const CHART_CATEGORICAL = ['#2a78d6', '#1baf7a', '#eda100', '#008300', '#4a3aa7', '#e34948', '#e87ba4', '#eb6834'];
const CHART_BRAND = '#128c7e';
const CHART_INK_SECONDARY = '#54656f';
const CHART_INK_MUTED = '#8696a0';
const CHART_GRIDLINE = '#e9edef';
// 4-step ordinal ramp (single hue, light->dark) for the funnel's ordered stages.
const CHART_SEQUENTIAL_4 = ['#9ec5f4', '#5598e7', '#2a78d6', '#184f95'];

function chartEscapeHtml(str) {
  return String(str).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

function chartFormatCompactNumber(n) {
  const abs = Math.abs(n);
  if (abs >= 1000000) return `${(n / 1000000).toFixed(1).replace(/\.0$/, '')}jt`;
  if (abs >= 1000) return `${(n / 1000).toFixed(1).replace(/\.0$/, '')}rb`;
  return String(Math.round(n));
}

function chartFormatRupiahCompact(n) {
  return `Rp ${chartFormatCompactNumber(n)}`;
}

function chartTruncate(str, max) {
  const s = String(str);
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

// ---- Shared tooltip (one floating element, reused by every chart) ----

let chartTooltipEl = null;
function chartTooltip() {
  if (!chartTooltipEl) {
    chartTooltipEl = document.createElement('div');
    chartTooltipEl.className = 'chart-tooltip hidden';
    document.body.appendChild(chartTooltipEl);
  }
  return chartTooltipEl;
}
function chartShowTooltip(clientX, clientY, html) {
  const el = chartTooltip();
  el.innerHTML = html;
  el.classList.remove('hidden');
  const maxLeft = window.innerWidth - el.offsetWidth - 16;
  el.style.left = `${Math.max(8, Math.min(clientX + 14, maxLeft))}px`;
  el.style.top = `${clientY + 14}px`;
}
function chartHideTooltip() {
  if (chartTooltipEl) chartTooltipEl.classList.add('hidden');
}

function chartEmpty(container, message) {
  container.innerHTML = `<div class="chart-empty">${chartEscapeHtml(message)}</div>`;
}

function chartLegend(items) {
  // items: [{ label, color }] - a legend box is always shown for 2+ series;
  // a single series doesn't get one (the chart title already names it).
  if (items.length < 2) return '';
  return `<div class="chart-legend">${items.map((it) => `
    <span class="chart-legend-item"><span class="chart-legend-swatch" style="background:${it.color}"></span>${chartEscapeHtml(it.label)}</span>
  `).join('')}</div>`;
}

// ---- Bar chart (single series, vertical columns) ----

function renderBarChart(container, data, { xKey, yKey, color = CHART_BRAND, formatValue = String, emptyMessage = 'Belum ada data.' }) {
  if (!data || data.length === 0) return chartEmpty(container, emptyMessage);

  const width = Math.max(container.clientWidth || 560, 280);
  const height = 260;
  const marginLeft = 46, marginRight = 12, marginTop = 16, marginBottom = 58;
  const plotW = width - marginLeft - marginRight;
  const plotH = height - marginTop - marginBottom;

  const maxVal = Math.max(...data.map((d) => d[yKey]), 1);
  const slot = plotW / data.length;
  const barWidth = Math.min(24, slot * 0.55);

  const yTicks = 4;
  let grid = '';
  for (let i = 0; i <= yTicks; i++) {
    const v = (maxVal / yTicks) * i;
    const y = marginTop + plotH - (v / maxVal) * plotH;
    grid += `<line x1="${marginLeft}" y1="${y}" x2="${width - marginRight}" y2="${y}" stroke="${CHART_GRIDLINE}" stroke-width="1" />
      <text x="${marginLeft - 8}" y="${y + 3}" text-anchor="end" font-size="10" fill="${CHART_INK_MUTED}">${chartEscapeHtml(formatValue(v))}</text>`;
  }

  let bars = '';
  data.forEach((d, i) => {
    const val = d[yKey];
    const barH = maxVal > 0 ? (val / maxVal) * plotH : 0;
    const x = marginLeft + i * slot + (slot - barWidth) / 2;
    const y = marginTop + plotH - barH;
    const labelText = chartTruncate(d[xKey], 12);
    const tooltipHtml = `<strong>${chartEscapeHtml(d[xKey])}</strong><br>${chartEscapeHtml(formatValue(val))}`;
    bars += `
      <g class="chart-mark" data-tooltip="${chartEscapeHtml(tooltipHtml)}">
        <rect x="${x - 6}" y="${marginTop}" width="${barWidth + 12}" height="${plotH}" fill="transparent" />
        <rect x="${x}" y="${y}" width="${barWidth}" height="${Math.max(barH, 1)}" rx="4" fill="${color}" />
        <text x="${x + barWidth / 2}" y="${height - marginBottom + 34}" text-anchor="end" font-size="10" fill="${CHART_INK_SECONDARY}"
          transform="rotate(-35 ${x + barWidth / 2} ${height - marginBottom + 34})">${chartEscapeHtml(labelText)}</text>
      </g>`;
  });

  container.innerHTML = `<svg viewBox="0 0 ${width} ${height}" class="chart-svg" preserveAspectRatio="xMidYMid meet">${grid}${bars}</svg>`;
  wireChartHover(container, data, xKey, [{ key: yKey, label: xKey, format: formatValue }]);
}

// ---- Grouped bar chart (two series per category, e.g. Lead vs Pesanan) ----

function renderGroupedBarChart(container, data, { xKey, series, formatValue = String, emptyMessage = 'Belum ada data.' }) {
  // series: [{ key, label, color }]
  if (!data || data.length === 0) return chartEmpty(container, emptyMessage);

  const width = Math.max(container.clientWidth || 560, 280);
  const height = 280;
  const marginLeft = 46, marginRight = 12, marginTop = 16, marginBottom = 64;
  const plotW = width - marginLeft - marginRight;
  const plotH = height - marginTop - marginBottom;

  const maxVal = Math.max(...data.flatMap((d) => series.map((s) => d[s.key] || 0)), 1);
  const slot = plotW / data.length;
  const groupWidth = Math.min(slot * 0.7, series.length * 16 + (series.length - 1) * 2);
  const barWidth = Math.min(14, (groupWidth - (series.length - 1) * 2) / series.length);

  const yTicks = 4;
  let grid = '';
  for (let i = 0; i <= yTicks; i++) {
    const v = (maxVal / yTicks) * i;
    const y = marginTop + plotH - (v / maxVal) * plotH;
    grid += `<line x1="${marginLeft}" y1="${y}" x2="${width - marginRight}" y2="${y}" stroke="${CHART_GRIDLINE}" stroke-width="1" />
      <text x="${marginLeft - 8}" y="${y + 3}" text-anchor="end" font-size="10" fill="${CHART_INK_MUTED}">${chartEscapeHtml(formatValue(v))}</text>`;
  }

  let bars = '';
  data.forEach((d, i) => {
    const groupX = marginLeft + i * slot + (slot - groupWidth) / 2;
    series.forEach((s, si) => {
      const val = d[s.key] || 0;
      const barH = maxVal > 0 ? (val / maxVal) * plotH : 0;
      const x = groupX + si * (barWidth + 2);
      const y = marginTop + plotH - barH;
      const tooltipHtml = `<strong>${chartEscapeHtml(d[xKey])}</strong><br>${chartEscapeHtml(s.label)}: ${chartEscapeHtml(formatValue(val))}`;
      bars += `
        <g class="chart-mark" data-tooltip="${chartEscapeHtml(tooltipHtml)}">
          <rect x="${x - 2}" y="${marginTop}" width="${barWidth + 4}" height="${plotH}" fill="transparent" />
          <rect x="${x}" y="${y}" width="${barWidth}" height="${Math.max(barH, 1)}" rx="3" fill="${s.color}" />
        </g>`;
    });
    const labelText = chartTruncate(d[xKey], 14);
    bars += `<text x="${groupX + groupWidth / 2}" y="${height - marginBottom + 34}" text-anchor="end" font-size="10" fill="${CHART_INK_SECONDARY}"
      transform="rotate(-35 ${groupX + groupWidth / 2} ${height - marginBottom + 34})">${chartEscapeHtml(labelText)}</text>`;
  });

  container.innerHTML = `
    ${chartLegend(series.map((s) => ({ label: s.label, color: s.color })))}
    <svg viewBox="0 0 ${width} ${height}" class="chart-svg" preserveAspectRatio="xMidYMid meet">${grid}${bars}</svg>`;
  wireChartHover(container.querySelector('.chart-svg') ? container : container, data, xKey, series);
}

// ---- Line chart (single series time trend) ----

function renderLineChart(container, data, { xKey, yKey, color = CHART_BRAND, formatValue = String, emptyMessage = 'Belum ada data.' }) {
  if (!data || data.length === 0) return chartEmpty(container, emptyMessage);

  const width = Math.max(container.clientWidth || 560, 280);
  const height = 240;
  const marginLeft = 50, marginRight = 16, marginTop = 16, marginBottom = 34;
  const plotW = width - marginLeft - marginRight;
  const plotH = height - marginTop - marginBottom;

  const maxVal = Math.max(...data.map((d) => d[yKey]), 1);
  const stepX = data.length > 1 ? plotW / (data.length - 1) : 0;
  const pointAt = (i) => ({
    x: marginLeft + i * stepX,
    y: marginTop + plotH - (data[i][yKey] / maxVal) * plotH,
  });

  const yTicks = 4;
  let grid = '';
  for (let i = 0; i <= yTicks; i++) {
    const v = (maxVal / yTicks) * i;
    const y = marginTop + plotH - (v / maxVal) * plotH;
    grid += `<line x1="${marginLeft}" y1="${y}" x2="${width - marginRight}" y2="${y}" stroke="${CHART_GRIDLINE}" stroke-width="1" />
      <text x="${marginLeft - 8}" y="${y + 3}" text-anchor="end" font-size="10" fill="${CHART_INK_MUTED}">${chartEscapeHtml(formatValue(v))}</text>`;
  }

  const linePoints = data.map((_, i) => pointAt(i)).map((p) => `${p.x},${p.y}`).join(' ');
  const areaPoints = `${marginLeft},${marginTop + plotH} ${linePoints} ${marginLeft + plotW},${marginTop + plotH}`;

  // Sparse x-axis labels - first, last, and a few in between, never every point.
  const labelEvery = Math.max(1, Math.ceil(data.length / 6));
  let xLabels = '';
  data.forEach((d, i) => {
    if (i % labelEvery !== 0 && i !== data.length - 1) return;
    const p = pointAt(i);
    xLabels += `<text x="${p.x}" y="${height - marginBottom + 16}" text-anchor="middle" font-size="10" fill="${CHART_INK_SECONDARY}">${chartEscapeHtml(chartShortDate(d[xKey]))}</text>`;
  });

  let hitMarks = '';
  data.forEach((d, i) => {
    const p = pointAt(i);
    const tooltipHtml = `<strong>${chartEscapeHtml(chartShortDate(d[xKey]))}</strong><br>${chartEscapeHtml(formatValue(d[yKey]))}`;
    hitMarks += `
      <g class="chart-mark" data-tooltip="${chartEscapeHtml(tooltipHtml)}">
        <rect x="${p.x - Math.max(stepX / 2, 8)}" y="${marginTop}" width="${Math.max(stepX, 16)}" height="${plotH}" fill="transparent" />
        <circle cx="${p.x}" cy="${p.y}" r="4" fill="${color}" stroke="#ffffff" stroke-width="2" />
      </g>`;
  });

  container.innerHTML = `<svg viewBox="0 0 ${width} ${height}" class="chart-svg" preserveAspectRatio="xMidYMid meet">
    ${grid}
    <polygon points="${areaPoints}" fill="${color}" opacity="0.1" />
    <polyline points="${linePoints}" fill="none" stroke="${color}" stroke-width="2" stroke-linejoin="round" stroke-linecap="round" />
    ${hitMarks}
    ${xLabels}
  </svg>`;
  wireChartHover(container, data, xKey, [{ key: yKey, label: xKey, format: formatValue }]);
}

function chartShortDate(isoDate) {
  const d = new Date(`${isoDate}T00:00:00`);
  if (isNaN(d.getTime())) return isoDate;
  return d.toLocaleDateString('id-ID', { day: '2-digit', month: 'short' });
}

// ---- Funnel (ordered horizontal bars, single sequential hue) ----

function renderFunnelChart(container, stages) {
  // stages: [{ label, value }], already in funnel order (widest first)
  if (!stages || stages.length === 0 || stages[0].value === 0) {
    return chartEmpty(container, 'Belum ada data.');
  }
  const maxVal = stages[0].value || 1;
  const rowH = 40, gap = 10;
  const width = Math.max(container.clientWidth || 560, 280);
  const height = stages.length * (rowH + gap);
  const maxBarW = width - 140;

  let rows = '';
  stages.forEach((s, i) => {
    const barW = Math.max((s.value / maxVal) * maxBarW, 2);
    const y = i * (rowH + gap);
    const pct = maxVal > 0 ? Math.round((s.value / maxVal) * 1000) / 10 : 0;
    const color = CHART_SEQUENTIAL_4[Math.min(i, CHART_SEQUENTIAL_4.length - 1)];
    rows += `
      <g class="chart-mark" data-tooltip="${chartEscapeHtml(`<strong>${s.label}</strong><br>${s.value.toLocaleString('id-ID')} (${pct}%)`)}">
        <rect x="0" y="${y}" width="${width}" height="${rowH}" fill="transparent" />
        <text x="0" y="${y + 14}" font-size="11" fill="${CHART_INK_SECONDARY}">${chartEscapeHtml(s.label)}</text>
        <rect x="0" y="${y + 18}" width="${barW}" height="16" rx="4" fill="${color}" />
        <text x="${barW + 8}" y="${y + 30}" font-size="11" font-weight="600" fill="#0b0b0b">${s.value.toLocaleString('id-ID')}</text>
      </g>`;
  });

  container.innerHTML = `<svg viewBox="0 0 ${width} ${height}" class="chart-svg" preserveAspectRatio="xMidYMid meet">${rows}</svg>`;
  wireChartHover(container);
}

// ---- Shared hover wiring ----
// Every chart's marks carry a data-tooltip attribute already rendered as
// HTML - this just shows/hides the shared tooltip on hover/move/leave.

function wireChartHover(container) {
  container.querySelectorAll('.chart-mark').forEach((mark) => {
    const html = mark.getAttribute('data-tooltip');
    if (!html) return;
    mark.addEventListener('mousemove', (e) => chartShowTooltip(e.clientX, e.clientY, html));
    mark.addEventListener('mouseleave', chartHideTooltip);
  });
}
