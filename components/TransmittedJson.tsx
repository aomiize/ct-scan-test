'use client';

import { useState } from 'react';
import type { Analysis } from '@/lib/analysis';
import { copyText, downloadText } from '@/lib/download';
import { deriveIndices, EDGE_FIELD_INFO, EDGE_FIELDS } from '@/lib/edge';

function Block({ title, sub, value, file, extra }: { title: string; sub: string; value: unknown; file: string; extra?: React.ReactNode }) {
  const text = typeof value === 'string' ? value : JSON.stringify(value, null, 2);
  const [copied, setCopied] = useState(false);
  return (
    <section className="panel">
      <div className="panel-head">
        <div><h3>{title}</h3><p>{sub}</p></div>
        <div className="row">
          {extra}
          <button type="button" className="btn small" onClick={async () => { if (await copyText(text)) { setCopied(true); setTimeout(() => setCopied(false), 1400); } }}>{copied ? 'Copied' : 'Copy'}</button>
          <button type="button" className="btn small" onClick={() => downloadText(text, file, 'application/json')}>Download</button>
        </div>
      </div>
      <pre className="code">{text}</pre>
    </section>
  );
}

const fmt = (v: number | null) => (v == null ? '—' : Math.abs(v) >= 1000 ? Math.round(v).toLocaleString('en-US') : String(v));

export default function TransmittedJson({ a }: { a: Analysis }) {
  if (!a.payload) return <div className="page"><p className="empty">Open a CT volume to begin.</p></div>;
  const ref = a.payload.case_ref;
  const sent = a.report?.source === 'llm' ? a.report : null;
  const edge = sent?.transmitted ?? a.edge;
  const check = a.edgeCheck;
  const range = a.edgeRange;

  return (
    <div className="page">
      <p className="banner">
        Only the eight numbers below leave this device. They are checked against a fixed eight-field whitelist in the browser and again on the
        server before the language model is called; a payload with any other field, or any value that is not a number, is blocked. CT images,
        masks, file names, patient details and DICOM tags never leave the device.
      </p>

      {!edge ? (
        <section className="panel"><p className="empty">Run or load a segmentation to produce the eight-field payload.</p></section>
      ) : (
        <>
          <section className="panel">
            <div className="panel-head">
              <div>
                <h3>De-identified biomarkers (8 fields)</h3>
                <p>
                  {range?.source === 'vertebrae'
                    ? `T12–L4, axial slices ${range.kMin + 1}–${range.kMax + 1} (vertebrae found by the segmentation server)`
                    : range
                      ? `Segmented range, slices ${range.kMin + 1}–${range.kMax + 1}. T12/L4 not found, so this is not exactly T12–L4`
                      : ''}
                </p>
              </div>
              <div className="row">
                {check?.ok ? (
                  <span className="pill ok">✓ whitelist passed · {check.bytes} bytes</span>
                ) : check ? (
                  <span className="pill bad" title={check.errors.join('\n')}>✕ blocked: {check.errors[0]}</span>
                ) : null}
              </div>
            </div>
            <div className="scroll-x">
              <table className="m">
                <thead><tr><th>Field</th><th style={{ textAlign: 'left' }}>Meaning</th><th>Value (sent)</th><th>Unit</th><th>Same in cm³ / cm</th></tr></thead>
                <tbody>
                  {EDGE_FIELDS.map((k) => (
                    <tr key={k}>
                      <td className="mono">{k}</td>
                      <td style={{ textAlign: 'left', fontFamily: 'var(--sans)' }}>{EDGE_FIELD_INFO[k].label}</td>
                      <td>{fmt(edge[k])}</td>
                      <td>{EDGE_FIELD_INFO[k].unit}</td>
                      <td><small>{edge[k] == null ? '' : k.endsWith('_mm3') ? `${(edge[k]! / 1000).toLocaleString('en-US', { maximumFractionDigits: 1 })} cm³` : k === 'body_height_mm' ? `${(edge[k]! / 10).toFixed(1)} cm` : ''}</small></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {range?.source !== 'vertebrae' && (
              <p className="banner warn" style={{ marginTop: 8 }}>
                T12 and L4 were not both found, so volumes and height cover every slice with tissue labels. Run segmentation with AUTO_L3=1 and
                TotalSegmentator installed on the edge device to get the exact T12–L4 range.
              </p>
            )}
          </section>

          <Block
            title={sent ? 'Payload (as sent)' : 'Payload'}
            sub={sent ? `Sent to ${sent.model} at ${new Date(sent.generatedAt).toLocaleString()}` : a.llm?.configured ? 'Will be sent when you generate a report' : 'No language model configured; nothing is sent'}
            value={edge}
            file={`${ref}_edge_payload.json`}
          />
          <Block
            title="Derived indices"
            sub="Computed from the eight values at the prompt stage. They add no new information about the patient."
            value={deriveIndices(edge)}
            file={`${ref}_derived.json`}
          />
        </>
      )}

      {sent?.request ? (
        <Block title="Language model request" sub={`OpenAI-compatible chat completion · prompt SHA-256 ${sent.promptSha256}`} value={sent.request} file={`${ref}_llm_request.json`} />
      ) : null}
      {sent?.rawResponse ? <Block title="Raw model response" sub={`${sent.latencyMs} ms`} value={sent.rawResponse} file={`${ref}_llm_response.txt`} /> : null}
      {a.signature ? <Block title="Signature receipt" sub="Returned by the server after signing" value={a.signature} file={`${ref}_signature.json`} /> : null}

      <Block
        title="Local metrics (not transmitted)"
        sub="Full measurements used by the viewer, the rule-based draft and the signed record. They stay on this device."
        value={a.payload}
        file={`${ref}_local_metrics.json`}
      />
    </div>
  );
}
