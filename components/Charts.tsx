'use client';

import { useEffect, useRef, useState } from 'react';

function useWidth<T extends HTMLElement>() {
  const ref = useRef<T>(null);
  const [w, setW] = useState(600);
  useEffect(() => {
    if (!ref.current) return;
    const ro = new ResizeObserver(([e]) => setW(Math.max(200, Math.floor(e.contentRect.width))));
    ro.observe(ref.current);
    return () => ro.disconnect();
  }, []);
  return [ref, w] as const;
}

/** "Nice" axis maximum and ticks. */
function niceTicks(max: number, count = 4) {
  if (!(max > 0)) return { top: 1, ticks: [0, 1] };
  const raw = max / count;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => s >= raw)!;
  const top = Math.ceil(max / step) * step;
  const ticks: number[] = [];
  for (let v = 0; v <= top + 1e-9; v += step) ticks.push(+v.toFixed(6));
  return { top, ticks };
}
const fmt = (v: number) => (v === 0 ? '0' : Math.abs(v) >= 100 ? v.toFixed(0) : Math.abs(v) >= 10 ? v.toFixed(1) : v.toFixed(2));

export interface Series {
  name: string;
  color: string;
  values: ArrayLike<number>;
}

/** Multi-series line chart on one y-scale with a crosshair tooltip. x = index. */
export function LineChart({
  series, height = 220, unit, xLabel, xFormat = (i) => String(i + 1), markers = [], onPick,
}: {
  series: Series[];
  height?: number;
  unit: string;
  xLabel: string;
  xFormat?: (i: number) => string;
  markers?: { x: number; label: string }[];
  onPick?: (i: number) => void;
}) {
  const [ref, width] = useWidth<HTMLDivElement>();
  const [hover, setHover] = useState<number | null>(null);
  const n = series[0]?.values.length ?? 0;
  const pad = { l: 44, r: 12, t: 10, b: 30 };
  const W = width, H = height, iw = W - pad.l - pad.r, ih = H - pad.t - pad.b;
  let max = 0;
  for (const s of series) for (let i = 0; i < s.values.length; i++) max = Math.max(max, s.values[i]);
  const { top, ticks } = niceTicks(max);
  const x = (i: number) => pad.l + (n > 1 ? (i / (n - 1)) * iw : iw / 2);
  const y = (v: number) => pad.t + ih - (v / top) * ih;
  const path = (vals: ArrayLike<number>) => {
    let d = '';
    for (let i = 0; i < vals.length; i++) d += `${i ? 'L' : 'M'}${x(i).toFixed(1)},${y(vals[i]).toFixed(1)}`;
    return d;
  };
  const xTicks = n > 1 ? [0, Math.round((n - 1) / 4), Math.round((n - 1) / 2), Math.round((3 * (n - 1)) / 4), n - 1] : [0];

  const move = (e: React.PointerEvent<SVGSVGElement>) => {
    const r = e.currentTarget.getBoundingClientRect();
    const px = ((e.clientX - r.left) / r.width) * W;
    if (px < pad.l - 4 || px > W - pad.r + 4 || n < 1) return setHover(null);
    setHover(Math.max(0, Math.min(n - 1, Math.round(((px - pad.l) / iw) * (n - 1)))));
  };

  return (
    <div ref={ref} className="chart">
      <div className="legend">
        {series.map((s) => (
          <span key={s.name}><i style={{ background: s.color }} />{s.name}</span>
        ))}
      </div>
      <div className="chart-box">
        <svg width={W} height={H} viewBox={`0 0 ${W} ${H}`} onPointerMove={move} onPointerLeave={() => setHover(null)}
          onClick={() => hover != null && onPick?.(hover)} style={{ cursor: onPick ? 'pointer' : 'default' }} role="img"
          aria-label={`${series.map((s) => s.name).join(', ')} by ${xLabel}`}>
          {ticks.map((t) => (
            <g key={t}>
              <line x1={pad.l} x2={W - pad.r} y1={y(t)} y2={y(t)} className="grid-line" />
              <text x={pad.l - 6} y={y(t)} className="axis-text" textAnchor="end" dominantBaseline="middle">{fmt(t)}</text>
            </g>
          ))}
          {xTicks.map((i) => (
            <text key={i} x={x(i)} y={H - 10} className="axis-text" textAnchor="middle">{xFormat(i)}</text>
          ))}
          <text x={pad.l} y={H - 0} className="axis-text" dy={-0}>{''}</text>
          {markers
            .reduce<{ x: number; label: string }[]>((acc, m) => {
              const same = acc.find((o) => o.x === m.x);
              if (same) same.label += ` · ${m.label}`;
              else acc.push({ ...m });
              return acc;
            }, [])
            .map((m, i) => (
              <g key={m.label}>
                <line x1={x(m.x)} x2={x(m.x)} y1={pad.t} y2={pad.t + ih} className="marker-line" />
                <text x={x(m.x) + 4} y={pad.t + 10 + i * 13} className="axis-text strong">{m.label}</text>
              </g>
            ))}
          {series.map((s) => (
            <path key={s.name} d={path(s.values)} fill="none" stroke={s.color} strokeWidth={2} strokeLinejoin="round" />
          ))}
          {hover != null && (
            <g>
              <line x1={x(hover)} x2={x(hover)} y1={pad.t} y2={pad.t + ih} className="crosshair" />
              {series.map((s) => (
                <circle key={s.name} cx={x(hover)} cy={y(s.values[hover])} r={4} fill={s.color} className="dot-ring" />
              ))}
            </g>
          )}
        </svg>
        {hover != null && (
          <div className="tip" style={{ left: Math.min(W - 170, x(hover) + 12), top: pad.t }}>
            <b>{xLabel} {xFormat(hover)}</b>
            {series.map((s) => (
              <span key={s.name}><i style={{ background: s.color }} />{s.name}<em>{fmt(s.values[hover])} {unit}</em></span>
            ))}
          </div>
        )}
      </div>
      <div className="axis-caption">{unit} · {xLabel}</div>
    </div>
  );
}

/** Single-series area chart for resource samples (x = seconds). */
export function AreaChart({ t, v, unit, color, height = 120, max }: { t: number[]; v: (number | null)[]; unit: string; color: string; height?: number; max?: number }) {
  const [ref, width] = useWidth<HTMLDivElement>();
  const [hover, setHover] = useState<number | null>(null);
  const pts = t.map((tt, i) => [tt, v[i]] as const).filter((p): p is readonly [number, number] => p[1] != null && isFinite(p[1]));
  const pad = { l: 40, r: 8, t: 8, b: 22 };
  const W = width, H = height, iw = W - pad.l - pad.r, ih = H - pad.t - pad.b;
  if (pts.length < 2) return <div ref={ref} className="chart empty-chart">No samples recorded</div>;
  const t0 = pts[0][0], t1 = pts[pts.length - 1][0];
  const { top, ticks } = niceTicks(max ?? Math.max(...pts.map((p) => p[1])), 2);
  const x = (s: number) => pad.l + ((s - t0) / (t1 - t0 || 1)) * iw;
  const y = (val: number) => pad.t + ih - (val / top) * ih;
  const line = pts.map((p, i) => `${i ? 'L' : 'M'}${x(p[0]).toFixed(1)},${y(p[1]).toFixed(1)}`).join('');
  const area = `${line}L${x(t1)},${pad.t + ih}L${x(t0)},${pad.t + ih}Z`;
  const peak = pts.reduce((a, p) => (p[1] > a[1] ? p : a));
  const move = (e: React.PointerEvent<SVGSVGElement>) => {
    const r = e.currentTarget.getBoundingClientRect();
    const s = t0 + (((e.clientX - r.left) / r.width) * W - pad.l) / iw * (t1 - t0);
    let best = 0;
    for (let i = 1; i < pts.length; i++) if (Math.abs(pts[i][0] - s) < Math.abs(pts[best][0] - s)) best = i;
    setHover(best);
  };
  return (
    <div ref={ref} className="chart">
      <div className="chart-box">
        <svg width={W} height={H} onPointerMove={move} onPointerLeave={() => setHover(null)} role="img" aria-label={`${unit} over time`}>
          {ticks.map((tk) => (
            <g key={tk}>
              <line x1={pad.l} x2={W - pad.r} y1={y(tk)} y2={y(tk)} className="grid-line" />
              <text x={pad.l - 6} y={y(tk)} className="axis-text" textAnchor="end" dominantBaseline="middle">{fmt(tk)}</text>
            </g>
          ))}
          <text x={pad.l} y={H - 6} className="axis-text">{t0.toFixed(t1 < 10 ? 1 : 0)} s</text>
          <text x={W - pad.r} y={H - 6} className="axis-text" textAnchor="end">{t1.toFixed(t1 < 10 ? 1 : 0)} s</text>
          <path d={area} fill={color} opacity={0.18} />
          <path d={line} fill="none" stroke={color} strokeWidth={2} strokeLinejoin="round" />
          <circle cx={x(peak[0])} cy={y(peak[1])} r={4} fill={color} className="dot-ring" />
          {hover != null && (
            <>
              <line x1={x(pts[hover][0])} x2={x(pts[hover][0])} y1={pad.t} y2={pad.t + ih} className="crosshair" />
              <circle cx={x(pts[hover][0])} cy={y(pts[hover][1])} r={4} fill={color} className="dot-ring" />
            </>
          )}
        </svg>
        {hover != null && (
          <div className="tip" style={{ left: Math.min(W - 130, x(pts[hover][0]) + 10), top: 4 }}>
            <b>{pts[hover][0].toFixed(1)} s</b>
            <span><em>{fmt(pts[hover][1])} {unit}</em></span>
          </div>
        )}
      </div>
    </div>
  );
}

/** Donut with 2px surface gaps between segments and a centre total. */
export function Donut({ parts, size = 150, centre, sub }: { parts: { name: string; value: number; color: string }[]; size?: number; centre: string; sub: string }) {
  const total = parts.reduce((a, p) => a + p.value, 0);
  const r = size / 2 - 10, c = size / 2, sw = 16;
  const circ = 2 * Math.PI * r;
  let acc = 0;
  const [hover, setHover] = useState<number | null>(null);
  return (
    <div className="donut" style={{ width: size }}>
      <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} role="img" aria-label={`Composition: ${parts.map((p) => `${p.name} ${((p.value / (total || 1)) * 100).toFixed(1)}%`).join(', ')}`}>
        <circle cx={c} cy={c} r={r} fill="none" className="donut-track" strokeWidth={sw} />
        {total > 0 &&
          parts.map((p, i) => {
            const len = (p.value / total) * circ;
            const gap = parts.filter((q) => q.value > 0).length > 1 ? Math.min(2, len) : 0;
            const el = (
              <circle key={p.name} cx={c} cy={c} r={r} fill="none" stroke={p.color} strokeWidth={hover === i ? sw + 4 : sw}
                strokeDasharray={`${Math.max(0, len - gap)} ${circ}`} strokeDashoffset={-acc} transform={`rotate(-90 ${c} ${c})`}
                onPointerEnter={() => setHover(i)} onPointerLeave={() => setHover(null)} />
            );
            acc += len;
            return el;
          })}
      </svg>
      <div className="donut-centre">
        {hover != null ? (
          <>
            <b>{((parts[hover].value / (total || 1)) * 100).toFixed(1)}%</b>
            <span>{parts[hover].name}</span>
          </>
        ) : (
          <>
            <b>{centre}</b>
            <span>{sub}</span>
          </>
        )}
      </div>
    </div>
  );
}

/** Horizontal scale showing a value against a cut-off. */
export function CutoffBar({ value, cutoff, min, max, flagWhen, unit }: { value: number | null; cutoff: number | null; min: number; max: number; flagWhen: 'below' | 'above'; unit: string }) {
  const pos = (v: number) => `${Math.max(0, Math.min(100, ((v - min) / (max - min)) * 100))}%`;
  const bad = value != null && cutoff != null && (flagWhen === 'below' ? value < cutoff : value > cutoff);
  return (
    <div className="cbar">
      <div className="cbar-track">
        {cutoff != null && (
          <div className={`cbar-zone ${flagWhen}`} style={flagWhen === 'below' ? { left: 0, width: pos(cutoff) } : { left: pos(cutoff), right: 0 }} />
        )}
        {cutoff != null && <div className="cbar-cut" style={{ left: pos(cutoff) }} />}
        {value != null && <div className={`cbar-val ${bad ? 'bad' : 'ok'}`} style={{ left: pos(value) }} />}
      </div>
      <div className="cbar-scale">
        <span>{min}</span>
        {cutoff != null && <span style={{ left: pos(cutoff) }} className="mid">cut-off {cutoff} {unit}</span>}
        <span>{max}</span>
      </div>
    </div>
  );
}
