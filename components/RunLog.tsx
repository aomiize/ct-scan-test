'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { AreaChart } from './Charts';
import type { Analysis } from '@/lib/analysis';
import { downloadText } from '@/lib/download';
import { sessionLog, useSessionLog, type LogLine } from '@/lib/session-log';

const LEVELS = ['ALL', 'DEBUG', 'INFO', 'WARN', 'ERROR'] as const;
const RANK: Record<string, number> = { DEBUG: 0, INFO: 1, SUCCESS: 1, WARN: 2, ERROR: 3 };

export default function RunLog({ a, onRefresh }: { a: Analysis; onRefresh: () => void }) {
  const browser = useSessionLog();
  const [level, setLevel] = useState<(typeof LEVELS)[number]>('ALL');
  const [follow, setFollow] = useState(true);
  const [hideServer, setHideServer] = useState(false);
  const termRef = useRef<HTMLDivElement>(null);
  const run = a.run;

  const lines = useMemo(() => {
    const server: LogLine[] = hideServer || !run ? [] : run.logs.map((l) => ({ ...l, t: new Date(l.t).toISOString(), level: l.level as LogLine['level'], origin: 'server' }));
    return [...server, ...browser]
      .filter((l) => level === 'ALL' || (RANK[l.level] ?? 1) >= RANK[level])
      .sort((x, y) => x.t.localeCompare(y.t));
  }, [browser, run, level, hideServer]);

  useEffect(() => {
    if (follow && termRef.current) termRef.current.scrollTop = termRef.current.scrollHeight;
  }, [lines, follow]);

  const samples = run?.samples ?? [];
  const peak = (k: 'mem_used_mb' | 'gpu_util' | 'cpu_util' | 'temp_c' | 'power_w') => {
    const v = samples.map((s) => s[k]).filter((x): x is number => x != null);
    return v.length ? Math.max(...v) : null;
  };
  const memTotal = samples.find((s) => s.mem_total_mb)?.mem_total_mb ?? null;
  const inferS = run?.stages.inference ?? null;
  const hasGpu = samples.some((s) => s.gpu_util != null);

  const exportLog = () => {
    const text = lines.map((l) => `[${l.t}] [${l.origin}] [${l.level}] [${l.tag}] ${l.msg}`).join('\n') + '\n';
    downloadText(text, `${run?.id ?? 'session'}_bodycomp.log`);
  };

  return (
    <div className="page">
      <section className="panel">
        <div className="panel-head">
          <div>
            <h3>Segmentation run</h3>
            <p>{run ? `${run.filename} · ${run.model} on ${run.device} · started ${run.started}` : 'No server run yet. Open a CT and choose Run segmentation.'}</p>
          </div>
          {run && <button type="button" className="btn small" onClick={onRefresh}>Refresh</button>}
        </div>
        {run && (
          <div className="kpis small">
            <div className="kpi">
              <span className="k">Total wall time</span>
              <span className="v">{run.wall_s.toFixed(1)}<small>s</small></span>
              <span className="s">{Object.entries(run.stages).map(([k, v]) => `${k} ${v}s`).join(' · ') || '–'}</span>
            </div>
            <div className="kpi">
              <span className="k">Peak memory</span>
              <span className="v">{peak('mem_used_mb') != null ? (peak('mem_used_mb')! / 1024).toFixed(1) : '–'}<small>{memTotal ? `/ ${(memTotal / 1024).toFixed(1)} GB` : 'GB'}</small></span>
              <span className="s">sampler: {run.sampler}</span>
            </div>
            <div className="kpi">
              <span className="k">Throughput</span>
              <span className="v">{inferS && a.vol ? (a.vol.nz / inferS).toFixed(2) : '–'}<small>slices/s</small></span>
              <span className="s">{a.vol ? `${a.vol.nz} slices` : ''}{inferS ? ` in ${inferS}s inference` : ''}</span>
            </div>
            <div className="kpi">
              <span className="k">{hasGpu ? 'Peak GPU / temperature' : 'Peak CPU'}</span>
              <span className="v">{hasGpu ? `${peak('gpu_util') ?? '–'}%` : `${peak('cpu_util') ?? '–'}%`}<small>{peak('temp_c') != null ? `${peak('temp_c')} °C` : ''}</small></span>
              <span className="s">{peak('power_w') != null ? `peak ${peak('power_w')!.toFixed(1)} W` : 'power not reported'} · status {run.status}</span>
            </div>
          </div>
        )}
      </section>

      <section className="panel">
        <div className="toolbar">
          <span className="seg-inline" role="group" aria-label="Minimum level">
            {LEVELS.map((l) => <button type="button" key={l} aria-pressed={level === l} onClick={() => setLevel(l)}>{l}</button>)}
          </span>
          <label className="check"><input type="checkbox" checked={follow} onChange={(e) => setFollow(e.target.checked)} />Auto-scroll</label>
          <span className="sp" />
          <button type="button" className="btn small" onClick={exportLog} disabled={!lines.length}>Export .log</button>
          <button type="button" className="btn small" onClick={() => { sessionLog.clear(); setHideServer(true); }}>Clear view</button>
        </div>
        <div className="term" ref={termRef} role="log" aria-live="polite">
          {lines.length === 0 && <div className="term-empty">No log lines.</div>}
          {lines.map((l, i) => (
            <div key={i} className={`tl lv-${l.level.toLowerCase()}`}>
              <span className="tt">{l.t.slice(11, 23)}</span>
              <span className="to">{l.origin === 'server' ? 'srv' : 'web'}</span>
              <span className="tv">{l.level}</span>
              <span className="tg">{l.tag}</span>
              <span className="tm">{l.msg}</span>
            </div>
          ))}
        </div>
      </section>

      {run && (
        <section className="panel">
          <div className="panel-head"><div><h3>Resource profile</h3><p>Sampled every 0.5 s during the run ({run.sampler}). Dot marks the peak.</p></div></div>
          <div className="three">
            <div><h4>Memory used (MB)</h4><AreaChart t={samples.map((s) => s.t)} v={samples.map((s) => s.mem_used_mb ?? null)} unit="MB" color="var(--c-vat)" max={memTotal ?? undefined} /></div>
            <div><h4>{hasGpu ? 'GPU utilisation (%)' : 'CPU utilisation (%)'}</h4><AreaChart t={samples.map((s) => s.t)} v={samples.map((s) => (hasGpu ? s.gpu_util : s.cpu_util) ?? null)} unit="%" color="var(--c-muscle)" max={100} /></div>
            <div><h4>Power (W)</h4><AreaChart t={samples.map((s) => s.t)} v={samples.map((s) => s.power_w ?? null)} unit="W" color="var(--c-imat)" /></div>
          </div>
        </section>
      )}
    </div>
  );
}
