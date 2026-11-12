// Hand-rolled SVG charts following the dataviz mark specs: <=24px columns with
// 4px rounded data-ends, 2px lines, hairline recessive grid, hover tooltips,
// legend for >=2 series, and a table view for every chart.
import { useLayoutEffect, useRef, useState } from 'react';

function useWidth() {
  const ref = useRef(null);
  const [w, setW] = useState(0);
  useLayoutEffect(() => {
    if (!ref.current) return undefined;
    const ro = new ResizeObserver(([e]) => setW(Math.floor(e.contentRect.width)));
    ro.observe(ref.current);
    return () => ro.disconnect();
  }, []);
  return [ref, w];
}

function niceTicks(max, count = 4) {
  if (max <= 0) return [0];
  const raw = max / count;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => s >= raw);
  const ticks = [];
  for (let v = 0; v <= max + step * 0.001; v += step) ticks.push(Number(v.toFixed(6)));
  if (ticks[ticks.length - 1] < max) ticks.push(Number((ticks[ticks.length - 1] + step).toFixed(6)));
  return ticks;
}

const colPath = (x, y, w, h) => {
  const r = Math.min(4, h, w / 2);
  if (h <= 0) return '';
  return `M${x},${y + h}V${y + r}Q${x},${y} ${x + r},${y}H${x + w - r}Q${x + w},${y} ${x + w},${y + r}V${y + h}Z`;
};

function Tooltip({ tip }) {
  if (!tip) return null;
  return (
    <div className="viz-tip" style={{ left: tip.x, top: tip.y }} role="status">
      <strong>{tip.title}</strong>
      {tip.rows.map(([k, v, color]) => (
        <div key={k} className="viz-tip-row">
          {color && <span className="viz-key" style={{ background: color }} />}<span>{k}</span><b className="num">{v}</b>
        </div>
      ))}
    </div>
  );
}

/**
 * Daily columns: recorded days (series 1) and projected remaining days (series 2).
 * days: [{ label, value, kind: 'recorded' | 'projected', note? }]
 */
export function DailyColumns({ days, unit = 'kWh', height = 200, title }) {
  const [ref, width] = useWidth();
  const [tip, setTip] = useState(null);
  const pad = { t: 12, r: 8, b: 26, l: 36 };
  const iw = Math.max(0, width - pad.l - pad.r);
  const ih = height - pad.t - pad.b;
  const max = Math.max(1, ...days.map((d) => d.value));
  const ticks = niceTicks(max);
  const top = ticks[ticks.length - 1];
  const band = days.length ? iw / days.length : 0;
  const colW = Math.max(2, Math.min(24, band - 2));
  const y = (v) => pad.t + ih - (v / top) * ih;
  const labelEvery = Math.ceil(days.length / Math.max(1, Math.floor(iw / 44)));
  const fmt = (v) => `${v.toFixed(1)} ${unit}`;

  return (
    <figure className="viz">
      <div className="viz-legend" aria-hidden="true">
        <span><i className="viz-key" style={{ background: 'var(--series-1)' }} />Recorded</span>
        <span><i className="viz-key" style={{ background: 'var(--series-2)' }} />Projected</span>
      </div>
      <div ref={ref} className="viz-plot" onMouseLeave={() => setTip(null)}>
        {width > 0 && (
          <svg width={width} height={height} role="img" aria-label={title}>
            {ticks.map((t) => (
              <g key={t}>
                <line x1={pad.l} x2={width - pad.r} y1={y(t)} y2={y(t)} stroke={t === 0 ? 'var(--axis)' : 'var(--grid)'} strokeWidth="1" />
                <text x={pad.l - 6} y={y(t)} dy="0.32em" textAnchor="end" className="viz-tick num">{t}</text>
              </g>
            ))}
            {days.map((d, i) => {
              const cx = pad.l + band * i + band / 2;
              const h = (d.value / top) * ih;
              return (
                <g key={d.label + d.kind}>
                  <path d={colPath(cx - colW / 2, y(d.value), colW, h)} fill={d.kind === 'recorded' ? 'var(--series-1)' : 'var(--series-2)'}
                    opacity={tip && tip.i !== i ? 0.55 : 1} />
                  {i % labelEvery === 0 && (
                    <text x={cx} y={height - 8} textAnchor="middle" className="viz-tick">{d.label}</text>
                  )}
                  <rect x={pad.l + band * i} y={pad.t} width={band} height={ih} fill="transparent"
                    onMouseEnter={() => setTip({ i, x: Math.min(cx, width - 150), y: y(d.value) - 8, title: d.label,
                      rows: [[d.kind === 'recorded' ? 'Recorded' : 'Projected', fmt(d.value), d.kind === 'recorded' ? 'var(--series-1)' : 'var(--series-2)'], ...(d.note ? [[d.note, '']] : [])] })} />
                </g>
              );
            })}
          </svg>
        )}
        <Tooltip tip={tip} />
      </div>
      <details className="viz-table">
        <summary>Show as table</summary>
        <table>
          <thead><tr><th>Day</th><th>Type</th><th>{unit}</th></tr></thead>
          <tbody>{days.map((d) => <tr key={d.label + d.kind}><td>{d.label}</td><td>{d.kind}</td><td className="num">{d.value.toFixed(2)}</td></tr>)}</tbody>
        </table>
      </details>
    </figure>
  );
}

/**
 * Single-series line with a labelled reference line (e.g. gap ratio vs baseline).
 * points: [{ label, value }], value as a ratio (0..1) shown as %.
 */
export function RatioLine({ points, reference, referenceLabel, height = 170, title }) {
  const [ref, width] = useWidth();
  const [hover, setHover] = useState(null);
  const pad = { t: 14, r: 52, b: 22, l: 40 };
  const iw = Math.max(0, width - pad.l - pad.r);
  const ih = height - pad.t - pad.b;
  const vals = points.map((p) => p.value).filter((v) => v !== null);
  const max = Math.max(0.05, ...(vals.length ? vals : [0]), reference ?? 0) * 1.1;
  const ticks = niceTicks(max * 100, 3).map((t) => t / 100);
  const top = ticks[ticks.length - 1];
  const x = (i) => pad.l + (points.length > 1 ? (i / (points.length - 1)) * iw : iw / 2);
  const y = (v) => pad.t + ih - (Math.max(0, v) / top) * ih;
  const d = points.map((p, i) => (p.value === null ? null : `${x(i)},${y(p.value)}`)).filter(Boolean).join('L');
  const last = [...points].reverse().find((p) => p.value !== null);
  const lastI = last ? points.lastIndexOf(last) : -1;

  const onMove = (e) => {
    const rect = e.currentTarget.getBoundingClientRect();
    const i = Math.round(((e.clientX - rect.left - pad.l) / iw) * (points.length - 1));
    if (i >= 0 && i < points.length) setHover(i);
  };

  return (
    <figure className="viz">
      <div ref={ref} className="viz-plot" onMouseMove={onMove} onMouseLeave={() => setHover(null)}>
        {width > 0 && points.length > 0 && (
          <svg width={width} height={height} role="img" aria-label={title}>
            {ticks.map((t) => (
              <g key={t}>
                <line x1={pad.l} x2={width - pad.r} y1={y(t)} y2={y(t)} stroke={t === 0 ? 'var(--axis)' : 'var(--grid)'} />
                <text x={pad.l - 6} y={y(t)} dy="0.32em" textAnchor="end" className="viz-tick num">{(t * 100).toFixed(0)}%</text>
              </g>
            ))}
            {reference !== null && reference !== undefined && (
              <g>
                <line x1={pad.l} x2={width - pad.r} y1={y(reference)} y2={y(reference)} stroke="var(--ink-3)" strokeWidth="1" />
                <text x={width - pad.r + 4} y={y(reference)} dy="0.32em" className="viz-tick">{referenceLabel}</text>
              </g>
            )}
            <path d={`M${d}`} fill="none" stroke="var(--series-1)" strokeWidth="2" strokeLinejoin="round" strokeLinecap="round" />
            {lastI >= 0 && (
              <g>
                <circle cx={x(lastI)} cy={y(last.value)} r="6" fill="var(--surface)" />
                <circle cx={x(lastI)} cy={y(last.value)} r="4" fill="var(--series-1)" />
                <text x={x(lastI) + 8} y={y(last.value)} dy="0.32em" className="viz-label num">{(last.value * 100).toFixed(1)}%</text>
              </g>
            )}
            {hover !== null && points[hover]?.value !== null && (
              <g>
                <line x1={x(hover)} x2={x(hover)} y1={pad.t} y2={pad.t + ih} stroke="var(--line-strong)" />
                <circle cx={x(hover)} cy={y(points[hover].value)} r="6" fill="var(--surface)" />
                <circle cx={x(hover)} cy={y(points[hover].value)} r="4" fill="var(--series-1)" />
              </g>
            )}
            <text x={pad.l} y={height - 6} className="viz-tick">{points[0]?.label}</text>
            <text x={width - pad.r} y={height - 6} textAnchor="end" className="viz-tick">{points[points.length - 1]?.label}</text>
          </svg>
        )}
        {hover !== null && points[hover]?.value !== null && (
          <Tooltip tip={{ x: Math.min(x(hover), width - 160), y: y(points[hover].value) - 8, title: points[hover].label,
            rows: [['Gap', `${(points[hover].value * 100).toFixed(2)}%`, 'var(--series-1)'], ...(reference != null ? [[referenceLabel, `${(reference * 100).toFixed(2)}%`]] : [])] }} />
        )}
      </div>
      <details className="viz-table">
        <summary>Show as table</summary>
        <table>
          <thead><tr><th>Time</th><th>Gap</th></tr></thead>
          <tbody>{points.map((p, i) => <tr key={i}><td>{p.label}</td><td className="num">{p.value === null ? '—' : `${(p.value * 100).toFixed(2)}%`}</td></tr>)}</tbody>
        </table>
      </details>
    </figure>
  );
}
