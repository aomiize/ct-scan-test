'use client';

import { useMemo } from 'react';
import { LineChart } from './Charts';
import type { Analysis } from '@/lib/analysis';
import { sliceStats } from '@/lib/metrics';
import { labelVolume, roleProfile } from '@/lib/volumetrics';

const f1 = (v: number | null | undefined) => (v == null || !isFinite(v) ? '–' : v.toFixed(1));

export default function MetricsTable({ a, onCsv, onPickSlice }: { a: Analysis; onCsv: () => void; onPickSlice: (k: number) => void }) {
  const { vol, mask, labels, stats, l3, cur } = a;
  const l3s = useMemo(() => (vol && mask && l3 != null ? sliceStats(vol, mask.data, l3) : null), [vol, mask, l3]);
  const cs = useMemo(() => (vol && mask ? sliceStats(vol, mask.data, cur.k) : null), [vol, mask, cur.k]);
  const series = useMemo(() => {
    if (!vol || !stats) return [];
    return [
      { name: 'Muscle', color: 'var(--c-muscle)', values: roleProfile(vol, labels, stats, 'muscle') },
      { name: 'Visceral fat', color: 'var(--c-vat)', values: roleProfile(vol, labels, stats, 'vat') },
      { name: 'Subcutaneous fat', color: 'var(--c-sat)', values: roleProfile(vol, labels, stats, 'sat') },
      { name: 'Intermuscular fat', color: 'var(--c-imat)', values: roleProfile(vol, labels, stats, 'imat') },
    ].filter((s) => Array.from(s.values).some((v) => v > 0));
  }, [vol, labels, stats]);

  if (!vol || !mask || !stats) return <div className="page"><p className="empty">Load a CT and a segmentation to see per-label metrics.</p></div>;
  const px = (vol.sx * vol.sy) / 100;

  return (
    <div className="page">
      <section className="panel">
        <div className="panel-head">
          <div><h3>Per-label metrics</h3><p>Volume and attenuation over the whole mask; areas on the current slice ({cur.k + 1}) and at L3{l3 != null ? ` (${l3 + 1})` : ''}</p></div>
          <button type="button" className="btn" onClick={onCsv}>Export CSV</button>
        </div>
        <div className="scroll-x">
          <table className="m">
            <thead>
              <tr>
                <th>Label</th><th>Role</th><th>Voxels</th><th>Volume cm³</th><th>Mean HU</th><th>SD HU</th>
                <th>Slice {cur.k + 1} cm²</th><th>L3 cm²</th><th>L3 mean HU</th>
              </tr>
            </thead>
            <tbody>
              {Object.entries(labels).map(([L, d]) => {
                const v = labelVolume(vol, stats, +L);
                const n3 = l3s?.n[+L] ?? 0;
                return (
                  <tr key={L}>
                    <td><span className="sw" style={{ background: `rgb(${d.color.join(',')})` }} />{L} · {d.name}</td>
                    <td>{d.role}</td>
                    <td>{v.voxels.toLocaleString()}</td>
                    <td>{f1(v.cm3)}</td>
                    <td>{f1(v.meanHU)}</td>
                    <td>{f1(v.sdHU)}</td>
                    <td>{cs ? f1(cs.n[+L] * px) : '–'}</td>
                    <td>{l3s ? f1(n3 * px) : '–'}</td>
                    <td>{l3s && n3 ? f1(l3s.sum[+L] / n3) : '–'}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        <p className="disc">Voxel spacing {vol.sx.toFixed(3)} × {vol.sy.toFixed(3)} × {vol.sz.toFixed(3)} mm. Segmented slices {stats.kMin + 1}–{stats.kMax + 1} of {vol.nz}.</p>
      </section>

      <section className="panel">
        <div className="panel-head">
          <div><h3>Cross-sectional area by axial slice</h3><p>Click the chart to jump the viewers to that slice</p></div>
        </div>
        {series.length ? (
          <LineChart
            series={series}
            unit="cm²"
            xLabel="Axial slice"
            markers={[...(l3 != null ? [{ x: l3, label: 'L3' }] : []), { x: cur.k, label: 'current' }]}
            onPick={onPickSlice}
          />
        ) : (
          <p className="empty">No muscle or fat labels to plot. Assign roles to the labels in the sidebar.</p>
        )}
        <details className="table-view">
          <summary>Show as table</summary>
          <div className="scroll-x tall">
            <table className="m">
              <thead><tr><th>Slice</th><th>z mm</th>{series.map((s) => <th key={s.name}>{s.name} cm²</th>)}</tr></thead>
              <tbody>
                {Array.from({ length: vol.nz }, (_, k) => (
                  <tr key={k} className={k === l3 ? 'hl' : ''}>
                    <td>{k + 1}{k === l3 ? ' · L3' : ''}</td>
                    <td>{(k * vol.sz).toFixed(1)}</td>
                    {series.map((s) => <td key={s.name}>{f1(s.values[k])}</td>)}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </details>
      </section>
    </div>
  );
}
