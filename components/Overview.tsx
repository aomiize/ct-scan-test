'use client';

import { useMemo } from 'react';
import { Donut } from './Charts';
import Mesh3D from './Mesh3D';
import type { Analysis } from '@/lib/analysis';
import { evaluate, roleMetrics, sliceStats } from '@/lib/metrics';
import { REFERENCE } from '@/lib/reference';
import { roleVolumes } from '@/lib/volumetrics';

const f1 = (v: number | null | undefined) => (v == null || !isFinite(v) ? '–' : v.toFixed(1));
const f0 = (v: number | null | undefined) => (v == null || !isFinite(v) ? '–' : Math.round(v).toLocaleString());

export function Status({ flag, yes, no }: { flag: boolean | null; yes: string; no: string }) {
  if (flag == null) return <span className="pill na">no reference</span>;
  return flag ? <span className="pill bad">▲ {yes}</span> : <span className="pill ok">● {no}</span>;
}

export default function Overview({ a, viewport, onGenerate, onPrint, onCsv, busy }: {
  a: Analysis;
  viewport: React.ReactNode;
  onGenerate: () => void;
  onPrint: () => void;
  onCsv: () => void;
  busy: boolean;
}) {
  const { vol, mask, labels, stats, patient, l3 } = a;
  const rv = useMemo(() => (vol && stats ? roleVolumes(vol, labels, stats) : null), [vol, labels, stats]);
  const ev = useMemo(() => (vol && mask && l3 != null ? evaluate(roleMetrics(vol, labels, sliceStats(vol, mask.data, l3)), patient) : null), [vol, mask, labels, l3, patient]);
  const adipose = rv ? rv.sat.cm3 + rv.vat.cm3 + rv.imat.cm3 : null;
  const tissue = rv && adipose != null ? adipose + rv.muscle.cm3 : null;
  const extent = a.payload?.scan.segmented_extent_mm;

  const parts = rv
    ? [
        { name: 'Muscle', value: rv.muscle.cm3, color: 'var(--c-muscle)' },
        { name: 'Visceral fat', value: rv.vat.cm3, color: 'var(--c-vat)' },
        { name: 'Subcutaneous fat', value: rv.sat.cm3, color: 'var(--c-sat)' },
        { name: 'Intermuscular fat', value: rv.imat.cm3, color: 'var(--c-imat)' },
      ]
    : [];

  const indices = ev
    ? [
        { k: 'Skeletal muscle index', v: f1(ev.smi), u: 'cm²/m²', ref: ev.smiCut ? `≥ ${ev.smiCut}` : '–', flag: ev.lowMuscle, yes: 'Low', no: 'Normal', src: REFERENCE.smi(patient)?.source },
        { k: 'Muscle attenuation', v: f1(ev.muscleHU), u: 'HU', ref: ev.huCut ? `≥ ${ev.huCut}` : '–', flag: ev.myosteatosis, yes: 'Low', no: 'Normal', src: REFERENCE.smra(patient)?.source },
        { k: 'Visceral fat area', v: f1(ev.vat), u: 'cm²', ref: ev.vatCut ? `≤ ${ev.vatCut}` : '–', flag: ev.visceralObesity, yes: 'High', no: 'Normal', src: REFERENCE.vatArea(patient)?.source },
        { k: 'VAT / SAT ratio', v: ev.vatSat == null ? '–' : ev.vatSat.toFixed(2), u: '', ref: '–', flag: null, yes: '', no: '', src: undefined },
        { k: 'Adipose share', v: tissue ? f1((adipose! / tissue) * 100) : '–', u: '%', ref: '–', flag: null, yes: '', no: '', src: undefined },
      ]
    : [];

  return (
    <div className="page">
      <section className="kpis">
        <div className="kpi">
          <span className="k">Muscle volume</span>
          <span className="v">{f0(rv?.muscle.cm3)}<small>cm³</small></span>
          <span className="s">{extent ? `over ${extent} mm segmented range` : 'segmented range'}</span>
        </div>
        <div className="kpi">
          <span className="k">Muscle attenuation · L3</span>
          <span className="v">{f1(ev?.muscleHU)}<small>HU</small></span>
          <span className="s">{ev ? <Status flag={ev.myosteatosis} yes={`below ${ev.huCut} HU`} no={`≥ ${ev.huCut} HU`} /> : 'set L3 to compute'}</span>
        </div>
        <div className="kpi">
          <span className="k">Visceral fat volume</span>
          <span className="v">{f0(rv?.vat.cm3)}<small>cm³</small></span>
          <span className="s">{ev?.vatSat != null ? `L3 VAT/SAT ratio ${ev.vatSat.toFixed(2)}` : 'VAT / SAT ratio at L3 –'}</span>
        </div>
        <div className="kpi">
          <span className="k">Total adipose</span>
          <span className="v">{f0(adipose)}<small>cm³</small></span>
          <span className="s">{tissue ? `${f1((adipose! / tissue) * 100)}% of segmented tissue` : 'VAT + SAT + IMAT'}</span>
        </div>
      </section>

      <section className="two">
        <div className="panel">
          <div className="panel-head">
            <div><h3>Axial slice with segmentation</h3><p>Slice {a.cur.k + 1}{l3 === a.cur.k ? ' (L3)' : ''} · rendered in this browser</p></div>
          </div>
          <div className="ov-viewport">{viewport}</div>
          <div className="legend">
            {Object.values(labels).map((d) => (
              <span key={d.name}><i style={{ background: `rgb(${d.color.join(',')})` }} />{d.name}</span>
            ))}
          </div>
        </div>
        <div className="panel">
          <div className="panel-head">
            <div><h3>3D model</h3><p>Surface of each label from the segmentation mask</p></div>
          </div>
          <Mesh3D vol={vol} mask={mask?.data ?? null} labels={labels} sliceK={a.cur.k} l3={l3} />
        </div>
      </section>

      <section className="two">
        <div className="panel">
          <div className="panel-head">
            <div>
              <h3>Assessment</h3>
              <p>{a.report ? (a.report.source === 'llm' ? `${a.report.model} · ${(a.report.latencyMs! / 1000).toFixed(1)} s · ${new Date(a.report.generatedAt).toLocaleString()}` : a.report.fallbackReason ? 'Rule-based draft · the model failed, see AI report' : 'Rule-based draft · no language model configured') : 'No draft yet'}</p>
            </div>
            {a.signature ? <span className="pill ok">Signed</span> : a.report ? <span className="pill na">Draft</span> : null}
          </div>
          {a.report ? (
            <div className="prose">
              {a.report.payloadKey !== a.payloadKey && <p className="banner warn">Metrics changed after this draft was written. Regenerate before signing.</p>}
              <p>{a.report.narrative.summary}</p>
              {a.report.narrative.recommendations.length > 0 && (
                <>
                  <h4>Suggested follow-up</h4>
                  <ul>{a.report.narrative.recommendations.map((r, i) => <li key={i}>{r}</li>)}</ul>
                </>
              )}
              <p className="disc">Draft for the reading physician. Review and sign it on the AI Report tab.</p>
            </div>
          ) : (
            <div className="empty-block">
              <p className="empty">{ev ? 'Generate a draft narrative from the measured values. Only de-identified numbers are sent.' : 'Load a segmentation and set the L3 slice first.'}</p>
              <button type="button" className="btn primary" onClick={onGenerate} disabled={!a.payload || busy}>{a.llm?.configured ? 'Generate AI report' : 'Generate rule-based draft'}</button>
            </div>
          )}
        </div>

        <div className="panel">
          <div className="panel-head">
            <div><h3>Tissue composition</h3><p>Volumes over the segmented range, and L3 indices against the configured references</p></div>
          </div>
          {rv && tissue ? (
            <div className="comp">
              <Donut parts={parts} centre={f0(tissue)} sub="cm³ total" />
              <ul className="comp-list">
                {parts.map((p) => (
                  <li key={p.name}>
                    <span><i style={{ background: p.color }} />{p.name}</span>
                    <b>{f0(p.value)} cm³</b>
                    <em>{f1((p.value / tissue) * 100)}%</em>
                    <span className="comp-bar"><span style={{ width: `${(p.value / tissue) * 100}%`, background: p.color }} /></span>
                  </li>
                ))}
              </ul>
            </div>
          ) : (
            <p className="empty">No segmentation loaded.</p>
          )}
          {indices.length > 0 && (
            <div className="scroll-x">
              <table className="m idx">
                <thead><tr><th>L3 index</th><th>Value</th><th>Reference</th><th>Status</th></tr></thead>
                <tbody>
                  {indices.map((r) => (
                    <tr key={r.k} title={r.src}>
                      <td>{r.k}</td>
                      <td>{r.v} <small>{r.u}</small></td>
                      <td>{r.ref}</td>
                      <td>{r.flag == null ? <span className="pill na">{r.ref === '–' ? 'no reference' : 'needs patient data'}</span> : <Status flag={r.flag} yes={r.yes} no={r.no} />}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          <div className="row end">
            <button type="button" className="btn" onClick={onPrint} disabled={!a.report}>Export report (PDF)</button>
            <button type="button" className="btn" onClick={onCsv} disabled={!mask}>Export metrics (CSV)</button>
          </div>
        </div>
      </section>
    </div>
  );
}
