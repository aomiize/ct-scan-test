'use client';

import { useMemo, useState } from 'react';
import { VIEW_COLOR } from '@/lib/labels';
import { buildReport, evaluate, measLength, reportText, roleMetrics, sliceStats } from '@/lib/metrics';
import type { Cursor, LabelMap, MaskState, Measurement, Patient, Volume } from '@/lib/types';

type Tab = 'metrics' | 'report' | 'meas';

interface Props {
  vol: Volume | null;
  ctName: string;
  sample: boolean;
  mask: MaskState | null;
  labels: LabelMap;
  scheme: string;
  patient: Patient;
  l3: number | null;
  cur: Cursor;
  meas: Measurement[];
  onGoMeas: (m: Measurement) => void;
  onDeleteMeas: (id: number) => void;
}

const f1 = (v: number | null | undefined) => (v == null || !isFinite(v) ? '–' : v.toFixed(1));
const f2 = (v: number | null | undefined) => (v == null || !isFinite(v) ? '–' : v.toFixed(2));

export default function InfoPanel(p: Props) {
  const [tab, setTab] = useState<Tab>('metrics');

  return (
    <section className="pane info">
      <div className="tabs" role="tablist">
        {([['metrics', 'L3 metrics'], ['report', 'Report'], ['meas', 'Measurements']] as [Tab, string][]).map(([t, n]) => (
          <button type="button" key={t} role="tab" className="tab" aria-selected={tab === t} onClick={() => setTab(t)}>
            {n}
            {t === 'meas' && p.meas.length > 0 && <span className="count">{p.meas.length}</span>}
          </button>
        ))}
      </div>
      <div className="tabbody">
        {!p.vol ? (
          <p className="empty">Open a CT volume to begin.</p>
        ) : tab === 'metrics' ? (
          <Metrics {...p} vol={p.vol} />
        ) : tab === 'report' ? (
          <ReportView {...p} vol={p.vol} />
        ) : (
          <MeasList {...p} vol={p.vol} />
        )}
      </div>
    </section>
  );
}

function Metrics({ vol, mask, labels, l3, cur, patient }: Props & { vol: Volume }) {
  const cs = useMemo(() => (mask ? sliceStats(vol, mask.data, cur.k) : null), [vol, mask, cur.k]);
  const ls = useMemo(() => (mask && l3 != null ? sliceStats(vol, mask.data, l3) : null), [vol, mask, l3]);
  const ev = useMemo(() => (ls ? evaluate(roleMetrics(vol, labels, ls), patient) : null), [vol, labels, ls, patient]);

  if (!mask || !cs) {
    return (
      <p className="empty">
        <b>No segmentation loaded.</b> Run segmentation, open a label mask from nnU-Net or TotalSegmentator <code>tissue_types</code> on the same grid as the CT, or build an HU threshold map for a quick estimate.
      </p>
    );
  }
  const px = (vol.sx * vol.sy) / 100;
  const pill = (flag: boolean | null, yes: string, no: string) =>
    flag == null ? <span className="pill na">needs sex, height, weight</span> : flag ? <span className="pill bad">{yes}</span> : <span className="pill ok">{no}</span>;

  return (
    <>
      <div className="hdr">
        <h3>Tissue areas</h3>
        <span className="sp tag">{mask.source === 'threshold' ? 'HU threshold map' : mask.name}</span>
      </div>
      <div className="scroll-x">
        <table className="m">
          <thead>
            <tr><th>Tissue</th><th>Slice {cur.k + 1} cm²</th><th>HU</th><th>L3 cm²</th><th>L3 HU</th></tr>
          </thead>
          <tbody>
            {Object.entries(labels).map(([L, d]) => {
              const n = cs.n[+L], ln = ls?.n[+L] ?? 0;
              return (
                <tr key={L}>
                  <td><span className="sw" style={{ background: `rgb(${d.color.join(',')})` }} />{d.name}</td>
                  <td>{f1(n * px)}</td>
                  <td>{n ? (cs.sum[+L] / n).toFixed(0) : '–'}</td>
                  <td>{ls ? f1(ln * px) : '–'}</td>
                  <td>{ls && ln ? (ls.sum[+L] / ln).toFixed(0) : '–'}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      {ev ? (
        <>
          <div className="cards">
            <div className="card"><span className="k">L3 SMA</span><span className="v">{f1(ev.sma)} <small>cm²</small></span><span className="s">skeletal muscle area</span></div>
            <div className="card"><span className="k">L3 SMI</span><span className="v">{f1(ev.smi)} <small>cm²/m²</small></span><span className="s">{ev.smiCut ? `cut-off <${ev.smiCut} · ` : ''}{pill(ev.lowMuscle, 'low muscle', 'normal')}</span></div>
            <div className="card"><span className="k">Muscle density</span><span className="v">{f1(ev.muscleHU)} <small>HU</small></span><span className="s">{ev.huCut ? `cut-off <${ev.huCut} · ` : ''}{pill(ev.myosteatosis, 'myosteatosis', 'normal')}</span></div>
            <div className="card"><span className="k">VAT / SAT</span><span className="v">{f1(ev.vat)} / {f1(ev.sat)} <small>cm²</small></span><span className="s">ratio {f2(ev.vatSat)}</span></div>
            <div className="card"><span className="k">IMAT</span><span className="v">{f1(ev.imat)} <small>cm²</small></span><span className="s">intermuscular fat</span></div>
          </div>
          <p className="disc">
            Cut-offs from Martin et al., J Clin Oncol 2013. SMI: men &lt;43 if BMI &lt;25, &lt;53 if BMI ≥25; women &lt;41. Muscle density: &lt;41 HU if BMI &lt;25, &lt;33 HU if BMI ≥25. Validate them for your population before clinical use.
          </p>
        </>
      ) : (
        <p className="empty gap">Scroll the axial view to the mid-L3 vertebral body and choose <b>Set L3 at current axial</b> to compute SMI and muscle density.</p>
      )}
    </>
  );
}

function ReportView(p: Props & { vol: Volume }) {
  const report = useMemo(
    () => buildReport({ vol: p.vol, ctName: p.ctName, sample: p.sample, mask: p.mask, labels: p.labels, scheme: p.scheme, patient: p.patient, l3: p.l3, meas: p.meas }),
    [p.vol, p.ctName, p.sample, p.mask, p.labels, p.scheme, p.patient, p.l3, p.meas],
  );
  const txt = reportText(report);
  const json = JSON.stringify(report, null, 2);
  const caseId = report.case_id || 'case';

  return (
    <>
      {txt ? (
        <>
          <div className="hdr">
            <h3>Summary</h3>
            <span className="sp row">
              <CopyButton text={txt} />
              <DownloadButton text={txt} name={`${caseId}_bodycomp.txt`} type="text/plain" />
            </span>
          </div>
          <textarea className="rep" readOnly value={txt} rows={16} />
        </>
      ) : (
        <p className="empty">Load a mask and set the L3 slice to produce the summary. The JSON below already holds geometry and label volumes.</p>
      )}
      <div className="hdr gap">
        <h3>Structured JSON</h3>
        <span className="sp row">
          <CopyButton text={json} />
          <DownloadButton text={json} name={`${caseId}_bodycomp.json`} type="application/json" />
        </span>
      </div>
      <textarea className="rep" readOnly value={json} rows={14} />
    </>
  );
}

function MeasList({ vol, meas, onGoMeas, onDeleteMeas }: Props & { vol: Volume }) {
  if (!meas.length) {
    return <p className="empty">Choose <b>Caliper</b> in Tools and drag across any view to measure a distance in millimetres. Each measurement stays on the slice where you drew it.</p>;
  }
  return (
    <table className="m">
      <thead><tr><th>View</th><th>Slice</th><th>Length mm</th><th /></tr></thead>
      <tbody>
        {meas.map((m) => (
          <tr key={m.id}>
            <td><span className="sw" style={{ background: VIEW_COLOR[m.view] }} />{m.view}</td>
            <td>{m.slice + 1}</td>
            <td>{measLength(vol, m).toFixed(1)}</td>
            <td>
              <button type="button" className="btn small" onClick={() => onGoMeas(m)}>Show</button>{' '}
              <button type="button" className="btn small" onClick={() => onDeleteMeas(m.id)}>Delete</button>
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function CopyButton({ text }: { text: string }) {
  const [done, setDone] = useState(false);
  return (
    <button
      type="button"
      className="btn small"
      onClick={() => {
        navigator.clipboard?.writeText(text).then(
          () => {
            setDone(true);
            setTimeout(() => setDone(false), 1400);
          },
          () => undefined,
        );
      }}
    >
      {done ? 'Copied' : 'Copy'}
    </button>
  );
}

function DownloadButton({ text, name, type }: { text: string; name: string; type: string }) {
  return (
    <button
      type="button"
      className="btn small"
      onClick={() => {
        const url = URL.createObjectURL(new Blob([text], { type }));
        const a = document.createElement('a');
        a.href = url;
        a.download = name;
        a.click();
        setTimeout(() => URL.revokeObjectURL(url), 1000);
      }}
    >
      Download
    </button>
  );
}
