'use client';

import { useState } from 'react';
import type { Analysis } from '@/lib/analysis';
import { copyText, downloadText } from '@/lib/download';

function Block({ title, sub, value, file }: { title: string; sub: string; value: unknown; file: string }) {
  const text = typeof value === 'string' ? value : JSON.stringify(value, null, 2);
  const [copied, setCopied] = useState(false);
  return (
    <section className="panel">
      <div className="panel-head">
        <div><h3>{title}</h3><p>{sub}</p></div>
        <div className="row">
          <button type="button" className="btn small" onClick={async () => { if (await copyText(text)) { setCopied(true); setTimeout(() => setCopied(false), 1400); } }}>{copied ? 'Copied' : 'Copy'}</button>
          <button type="button" className="btn small" onClick={() => downloadText(text, file, 'application/json')}>Download</button>
        </div>
      </div>
      <pre className="code">{text}</pre>
    </section>
  );
}

export default function TransmittedJson({ a }: { a: Analysis }) {
  if (!a.payload) return <div className="page"><p className="empty">Open a CT volume to begin.</p></div>;
  const sent = a.report?.source === 'llm';
  return (
    <div className="page">
      <p className="banner">
        This is everything that leaves the browser for report generation. The CT images, file name and patient identifiers are not included; the case is referred to by a hash.
      </p>
      <Block
        title={sent ? 'Metrics payload (as sent)' : 'Metrics payload'}
        sub={sent ? `Sent to ${a.report!.model} at ${new Date(a.report!.generatedAt).toLocaleString()}` : a.llm?.configured ? 'Will be sent when you generate a report' : 'No language model configured; nothing is sent'}
        value={a.payload}
        file={`${a.payload.case_ref}_payload.json`}
      />
      {a.report?.request ? (
        <Block title="Language model request" sub={`OpenAI-compatible chat completion · prompt SHA-256 ${a.report.promptSha256}`} value={a.report.request} file={`${a.payload.case_ref}_llm_request.json`} />
      ) : null}
      {a.report?.rawResponse ? <Block title="Raw model response" sub={`${a.report.latencyMs} ms`} value={a.report.rawResponse} file={`${a.payload.case_ref}_llm_response.txt`} /> : null}
      {a.signature ? <Block title="Signature receipt" sub="Returned by the server after signing" value={a.signature} file={`${a.payload.case_ref}_signature.json`} /> : null}
    </div>
  );
}
