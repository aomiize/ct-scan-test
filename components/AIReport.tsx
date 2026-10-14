'use client';

import { useMemo, useState } from 'react';
import { CutoffBar } from './Charts';
import { Status } from './Overview';
import SliceSnapshot from './SliceSnapshot';
import type { Analysis } from '@/lib/analysis';
import { evaluate, roleMetrics, sliceStats } from '@/lib/metrics';
import { REFERENCE } from '@/lib/reference';
import type { Narrative } from '@/lib/report-types';

const f1 = (v: number | null | undefined) => (v == null || !isFinite(v) ? '–' : v.toFixed(1));

interface Props {
  a: Analysis;
  busy: boolean;
  onGenerate: () => void;
  onPrint: () => void;
  onEdit: (n: Narrative) => void;
  onSign: (reader: string, remarks: string) => Promise<string | null>;
}

const SECTIONS: { key: keyof Omit<Narrative, 'recommendations'>; title: string }[] = [
  { key: 'examination', title: 'Examination and segmentation' },
  { key: 'muscle', title: 'Skeletal muscle' },
  { key: 'adipose', title: 'Adipose tissue' },
];

export default function AIReport({ a, busy, onGenerate, onPrint, onEdit, onSign }: Props) {
  const { vol, mask, labels, l3, patient, report, signature } = a;
  const [editing, setEditing] = useState(false);
  const [reader, setReader] = useState('');
  const [remarks, setRemarks] = useState('');
  const [signError, setSignError] = useState('');
  const [confirming, setConfirming] = useState(false);
  const l3s = useMemo(() => (vol && mask && l3 != null ? sliceStats(vol, mask.data, l3) : null), [vol, mask, l3]);
  const ev = useMemo(() => (vol && l3s ? evaluate(roleMetrics(vol, labels, l3s), patient) : null), [vol, labels, l3s, patient]);
  const stale = !!report && report.payloadKey !== a.payloadKey;
  const signed = !!signature;

  if (!vol) return <div className="page"><p className="empty">Open a CT volume to begin.</p></div>;

  const n = report?.narrative;
  const set = (patch: Partial<Narrative>) => n && onEdit({ ...n, ...patch });

  const sign = async () => {
    setSignError('');
    const err = await onSign(reader.trim(), remarks);
    if (err) setSignError(err);
    setConfirming(false);
  };

  return (
    <div className="page report-page print-area">
      <div className="toolbar no-print">
        <button type="button" className="btn primary" onClick={onGenerate} disabled={!a.payload || busy || signed}>
          {busy ? 'Generating…' : report ? 'Regenerate' : a.llm?.configured ? 'Generate AI report' : 'Generate rule-based draft'}
        </button>
        <button type="button" className="btn" onClick={() => setEditing((e) => !e)} disabled={!report || signed}>{editing ? 'Done editing' : 'Edit text'}</button>
        <button type="button" className="btn" onClick={onPrint} disabled={!report}>Print / save PDF</button>
        <span className="sp" />
        {signed ? <span className="pill ok">Signed by {signature!.reader}</span> : report ? <span className="pill na">Draft · pending sign-off</span> : null}
      </div>

      <section className="prov">
        <div><span className="k">Case</span><b>{a.payload?.case_ref ?? '–'}</b><small>{a.sample ? 'synthetic sample' : 'identifier hashed'}</small></div>
        <div><span className="k">Segmentation</span><b>{mask ? (mask.source === 'inference' ? `server model` : mask.source) : 'none'}</b><small>{a.run ? `run ${a.run.id} · ${a.run.wall_s}s · ${a.run.model}` : mask?.name ?? ''}</small></div>
        <div><span className="k">Narrative</span><b>{report ? (report.source === 'llm' ? report.model : 'Rule-based') : '–'}</b><small>{report?.source === 'llm' ? `temperature ${report.temperature} · ${(report.latencyMs! / 1000).toFixed(1)} s${(report.attempts ?? 1) > 1 ? ' · after retry' : ''}` : report?.fallbackReason ? 'model failed · fallback' : report ? 'no language model' : ''}</small></div>
        <div><span className="k">Prompt SHA-256</span><b className="mono">{report?.promptSha256 ? report.promptSha256.slice(0, 12) + '…' : '–'}</b><small>{report ? new Date(report.generatedAt).toLocaleString() : ''}</small></div>
        <div><span className="k">Status</span><b>{signed ? 'Signed' : stale ? 'Out of date' : report ? (report.edited ? 'Draft · edited' : 'Draft') : 'Not started'}</b><small>{signed ? new Date(signature!.signedAt).toLocaleString() : ''}</small></div>
      </section>

      {ev ? (
        <section className="risk">
          <RiskCard title="Low muscle mass" metric="Skeletal muscle index" value={ev.smi} unit="cm²/m²" cutoff={ev.smiCut} flag={ev.lowMuscle} flagWhen="below" yes="Below cut-off" no="Above cut-off" min={20} max={80} source={REFERENCE.smi(patient)?.source} />
          <RiskCard title="Myosteatosis" metric="Mean muscle attenuation" value={ev.muscleHU} unit="HU" cutoff={ev.huCut} flag={ev.myosteatosis} flagWhen="below" yes="Below cut-off" no="Above cut-off" min={0} max={70} source={REFERENCE.smra(patient)?.source} />
          <RiskCard title="Visceral obesity" metric="Visceral fat area" value={ev.vat} unit="cm²" cutoff={ev.vatCut} flag={ev.visceralObesity} flagWhen="above" yes="Above cut-off" no="Below cut-off" min={0} max={350} source={REFERENCE.vatArea(patient)?.source} />
        </section>
      ) : (
        <p className="banner">Load a segmentation and set the L3 slice to compute the indices.</p>
      )}

      <div className="report-cols">
        <div className="report-main">
          {!report ? (
            <div className="panel empty-block">
              <p className="empty">
                {a.llm?.configured
                  ? `Generate a draft with ${a.llm.model}. Only the de-identified numbers shown on the Transmitted JSON tab are sent.`
                  : 'No language model is configured (LLM_URL). A rule-based draft can be written from the measured values instead.'}
              </p>
            </div>
          ) : (
            <>
              {report.fallbackReason && (
                <p className="banner warn">
                  {a.llm?.model ?? 'The language model'} did not return a usable draft, so this is the rule-based draft instead. Reason: <span className="mono">{report.fallbackReason.slice(0, 240)}</span>. Choose Regenerate to try the model again.
                </p>
              )}
              {stale && !signed && <p className="banner warn">The metrics changed after this draft was written. Regenerate before signing.</p>}
              {report.unverifiedNumbers.length > 0 && (
                <p className="banner warn">
                  These numbers in the draft do not match any measured value: <b className="mono">{report.unverifiedNumbers.join(', ')}</b>. Check or remove them before signing.
                </p>
              )}
              <section className="panel finding">
                <h3>Summary</h3>
                {editing ? <textarea className="edit" value={n!.summary} onChange={(e) => set({ summary: e.target.value })} rows={4} /> : <p>{n!.summary}</p>}
              </section>
              {SECTIONS.map((s, i) => (
                <section key={s.key} className="panel finding">
                  <h3>{i + 1}. {s.title}</h3>
                  {editing ? <textarea className="edit" value={n![s.key]} onChange={(e) => set({ [s.key]: e.target.value })} rows={4} /> : <p>{n![s.key] || 'Not stated.'}</p>}
                  {s.key === 'muscle' && ev && (
                    <div className="facts">
                      <span>SMA <b>{f1(ev.sma)} cm²</b></span><span>SMI <b>{f1(ev.smi)} cm²/m²</b></span><span>Mean HU <b>{f1(ev.muscleHU)}</b></span>
                    </div>
                  )}
                  {s.key === 'adipose' && ev && (
                    <div className="facts">
                      <span>VAT <b>{f1(ev.vat)} cm²</b></span><span>SAT <b>{f1(ev.sat)} cm²</b></span><span>IMAT <b>{f1(ev.imat)} cm²</b></span><span>VAT/SAT <b>{ev.vatSat == null ? '–' : ev.vatSat.toFixed(2)}</b></span>
                    </div>
                  )}
                </section>
              ))}
              <section className="panel finding">
                <h3>4. Suggested follow-up</h3>
                {editing ? (
                  <textarea className="edit" value={n!.recommendations.join('\n')} onChange={(e) => set({ recommendations: e.target.value.split('\n').filter((x) => x.trim()) })} rows={5} />
                ) : n!.recommendations.length ? (
                  <ul>{n!.recommendations.map((r, i) => <li key={i}>{r}</li>)}</ul>
                ) : (
                  <p>None.</p>
                )}
              </section>
              <section className="panel finding">
                <h3>Limitations</h3>
                {editing ? <textarea className="edit" value={n!.limitations} onChange={(e) => set({ limitations: e.target.value })} rows={3} /> : <p>{n!.limitations}</p>}
              </section>
              {signed && remarks && (
                <section className="panel finding"><h3>Reader remarks</h3><p>{remarks}</p></section>
              )}
            </>
          )}
        </div>

        <aside className="report-side">
          <section className="panel">
            <div className="panel-head"><div><h3>Key anatomical evidence</h3><p>{l3 != null ? `L3 · axial slice ${l3 + 1} of ${vol.nz}` : 'L3 not set'}</p></div></div>
            {l3 != null && <SliceSnapshot vol={vol} mask={mask?.data ?? null} labels={labels} k={l3} lut={a.lut} caption={`W ${a.wl.w} / L ${a.wl.l} · ${mask ? 'mask overlay' : 'no mask'}`} />}
            {l3s && (
              <ul className="ev-list">
                {Object.entries(labels).map(([L, d]) => (
                  <li key={L}><i style={{ background: `rgb(${d.color.join(',')})` }} />{d.name}<b>{f1((l3s.n[+L] * vol.sx * vol.sy) / 100)} cm²</b><em>{l3s.n[+L] ? (l3s.sum[+L] / l3s.n[+L]).toFixed(0) : '–'} HU</em></li>
                ))}
              </ul>
            )}
          </section>

          <section className="panel attest no-print-controls">
            <div className="panel-head"><div><h3>Physician attestation</h3><p>{signed ? 'Signed and stored on the server' : 'Review the draft, then sign'}</p></div></div>
            {signed ? (
              <dl className="kv sig">
                <dt>Reader</dt><dd>{signature!.reader}</dd>
                <dt>Login</dt><dd>{signature!.authenticatedUser ?? 'not provided by proxy'}</dd>
                <dt>Signed</dt><dd>{new Date(signature!.signedAt).toLocaleString()}</dd>
                <dt>SHA-256</dt><dd className="mono">{signature!.sha256}</dd>
                <dt>Ed25519</dt><dd className="mono">{signature!.signature.slice(0, 44)}…</dd>
                <dt>Key</dt><dd className="mono">{signature!.keyFingerprint}</dd>
                <dt>Stored as</dt><dd className="mono">{signature!.file}</dd>
              </dl>
            ) : (
              <div className="attest-form no-print">
                <label className="field">Reading physician
                  <input id="reader" type="text" value={reader} onChange={(e) => setReader(e.target.value)} placeholder="Full name and credentials" autoComplete="name" />
                </label>
                <label className="field">Remarks or corrections
                  <textarea id="remarks" rows={4} value={remarks} onChange={(e) => setRemarks(e.target.value)} placeholder="Optional addendum stored with the signed report" />
                </label>
                {a.sample && <p className="note warn">The synthetic sample cannot be signed.</p>}
                {confirming ? (
                  <div className="confirm">
                    <p>Sign this report as <b>{reader.trim()}</b>? It cannot be changed afterwards.</p>
                    <div className="row">
                      <button type="button" className="btn primary" onClick={sign} disabled={busy}>Confirm and sign</button>
                      <button type="button" className="btn" onClick={() => setConfirming(false)}>Cancel</button>
                    </div>
                  </div>
                ) : (
                  <button type="button" className="btn primary" onClick={() => setConfirming(true)} disabled={!report || stale || !reader.trim() || a.sample || busy}>Sign and approve</button>
                )}
                {signError && <p className="status err">{signError}</p>}
                <p className="note">The server stores the metrics, narrative, model provenance and your remarks, and signs them with its Ed25519 key.</p>
              </div>
            )}
          </section>
          <p className="disc">Research and decision-support use. Not a cleared medical device. Automated measurements and generated text require review by a qualified reader before clinical use.</p>
        </aside>
      </div>
    </div>
  );
}

function RiskCard(p: { title: string; metric: string; value: number | null; unit: string; cutoff: number | null; flag: boolean | null; flagWhen: 'below' | 'above'; yes: string; no: string; min: number; max: number; source?: string }) {
  return (
    <div className={`riskcard ${p.flag ? 'bad' : p.flag === false ? 'ok' : ''}`}>
      <div className="rc-head"><b>{p.title}</b><Status flag={p.flag} yes={p.yes} no={p.no} /></div>
      <div className="rc-val">{f1(p.value)} <small>{p.unit}</small></div>
      <div className="rc-sub">{p.metric}{p.cutoff != null ? ` · cut-off ${p.flagWhen === 'below' ? '<' : '>'} ${p.cutoff}` : ' · needs sex, height, weight'}</div>
      <CutoffBar value={p.value} cutoff={p.cutoff} min={p.min} max={p.max} flagWhen={p.flagWhen} unit={p.unit} />
      {p.source && <div className="rc-src">{p.source}</div>}
    </div>
  );
}
