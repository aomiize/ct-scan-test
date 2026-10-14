'use client';

import { useEffect, useState } from 'react';
import { PRESETS, ROLES, SCHEME_NAMES } from '@/lib/labels';
import { bmi } from '@/lib/metrics';
import type { Cursor, LabelMap, MaskState, Patient, Role, SchemeKey, Tool, Volume, WindowLevel } from '@/lib/types';

type Scheme = Exclude<SchemeKey, 'threshold'>;
export interface CaseEntry {
  name: string;
  bytes: number;
  modified: string;
  mask: string | null;
}
interface Device {
  configured: boolean;
  online?: boolean;
  error?: string;
  device?: string;
  model?: string;
  busy?: boolean;
  sampler?: string;
  mem_used_mb?: number | null;
  mem_total_mb?: number | null;
  gpu_util?: number | null;
  cpu_util?: number | null;
  temp_c?: number | null;
  power_w?: number | null;
}

interface Props {
  vol: Volume | null;
  ctName: string;
  mask: MaskState | null;
  labels: LabelMap;
  scheme: Scheme;
  wl: WindowLevel;
  opacity: number;
  tool: Tool;
  l3: number | null;
  cur: Cursor;
  patient: Patient;
  status: { text: string; error?: boolean };
  busy: boolean;
  canSegment: boolean;
  inferenceReady: boolean | null;
  cases: { configured: boolean; cases: CaseEntry[]; error?: string } | null;
  llm: { configured: boolean; model: string | null } | null;
  canReport: boolean;
  reportBusy: boolean;
  onOpenCase: (c: CaseEntry) => void;
  onOpenCT: (f: File) => void;
  onOpenDicom: (files: File[]) => void;
  onOpenMask: (f: File) => void;
  onSample: () => void;
  onSegment: () => void;
  onThreshold: () => void;
  onScheme: (s: Scheme) => void;
  onLabel: (L: number, patch: Partial<{ visible: boolean; name: string; role: Role }>) => void;
  onWL: (wl: WindowLevel) => void;
  onOpacity: (o: number) => void;
  onTool: (t: Tool) => void;
  onResetViews: () => void;
  onClearMeas: () => void;
  onSetL3: () => void;
  onGoL3: () => void;
  onAxialScrub: (k: number) => void;
  onPatient: (p: Patient) => void;
  onGenerate: () => void;
}

const TOOLS: [Tool, string][] = [['cross', 'Cross'], ['wl', 'W/L'], ['pan', 'Pan'], ['cal', 'Caliper']];

function useDevice() {
  const [d, setD] = useState<Device | null>(null);
  useEffect(() => {
    let alive = true;
    const poll = () =>
      fetch('/api/device', { cache: 'no-store' })
        .then((r) => r.json())
        .then((j: Device) => alive && setD(j))
        .catch(() => alive && setD({ configured: true, online: false, error: 'network error' }));
    poll();
    const id = setInterval(poll, 10000);
    return () => {
      alive = false;
      clearInterval(id);
    };
  }, []);
  return d;
}

export default function Sidebar(p: Props) {
  const b = bmi(p.patient);
  const device = useDevice();
  const [caseSel, setCaseSel] = useState('');
  const pickFile = (cb: (f: File) => void) => (e: React.ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0];
    if (f) cb(f);
    e.target.value = '';
  };
  const memPct = device?.mem_used_mb && device.mem_total_mb ? (device.mem_used_mb / device.mem_total_mb) * 100 : null;

  return (
    <aside className="side no-print">
      <section className="sec">
        <h2>1 · Data input</h2>
        {p.cases?.configured && (
          <div className="row nowrap">
            <select id="case" className="grow" value={caseSel} onChange={(e) => setCaseSel(e.target.value)} aria-label="Case library">
              <option value="">{p.cases.cases.length ? 'Case library…' : 'Case library is empty'}</option>
              {p.cases.cases.map((c) => (
                <option key={c.name} value={c.name}>{c.name}{c.mask ? ' + mask' : ''}</option>
              ))}
            </select>
            <button type="button" className="btn" disabled={!caseSel || p.busy} onClick={() => { const c = p.cases!.cases.find((x) => x.name === caseSel); if (c) p.onOpenCase(c); }}>Open</button>
          </div>
        )}
        {p.cases?.error && <p className="status err">{p.cases.error}</p>}
        <div className="row">
          <label className="btn primary file">
            Open CT…
            <input id="f-ct" type="file" accept=".nii,.gz" onChange={pickFile(p.onOpenCT)} disabled={p.busy} />
          </label>
          <label className="btn file">
            Open mask…
            <input id="f-mask" type="file" accept=".nii,.gz" onChange={pickFile(p.onOpenMask)} disabled={p.busy || !p.vol} />
          </label>
          <button type="button" className="btn" onClick={p.onSample} disabled={p.busy}>Sample</button>
        </div>
        <div className="row">
          <label className={`btn file${p.inferenceReady ? '' : ' off'}`} title={p.inferenceReady ? 'Choose the folder that holds one DICOM study' : 'DICOM conversion runs on the inference server (INFERENCE_URL)'}>
            DICOM folder…
            <input id="f-dcm-dir" type="file" multiple onChange={(e) => { const fs = [...(e.target.files ?? [])]; e.target.value = ''; p.onOpenDicom(fs); }} disabled={p.busy || !p.inferenceReady} {...({ webkitdirectory: '', directory: '' } as Record<string, string>)} />
          </label>
          <label className={`btn file${p.inferenceReady ? '' : ' off'}`}>
            DICOM .zip…
            <input id="f-dcm-zip" type="file" accept=".zip" onChange={(e) => { const f = e.target.files?.[0]; e.target.value = ''; if (f) p.onOpenDicom([f]); }} disabled={p.busy || !p.inferenceReady} />
          </label>
        </div>
        {p.vol && (
          <dl className="kv">
            <dt>Grid</dt><dd>{p.vol.nx} × {p.vol.ny} × {p.vol.nz}</dd>
            <dt>Voxel</dt><dd>{p.vol.sx.toFixed(2)} × {p.vol.sy.toFixed(2)} × {p.vol.sz.toFixed(2)} mm</dd>
            <dt>Affine</dt><dd>{p.vol.src}</dd>
            <dt>Mask</dt><dd>{p.mask ? p.mask.name : 'none'}</dd>
          </dl>
        )}
        <p className={`status${p.status.error ? ' err' : ''}`} role="status">{p.status.text}</p>
      </section>

      <section className="sec">
        <h2>2 · Segmentation</h2>
        <div className="row">
          <button type="button" className="btn primary" onClick={p.onSegment} disabled={!p.canSegment || p.busy}>{p.busy ? 'Working…' : 'Run segmentation'}</button>
          <button type="button" className="btn small" onClick={p.onThreshold} disabled={!p.vol || p.busy}>HU threshold map</button>
        </div>
        <p className="note">
          {p.inferenceReady === false
            ? 'No inference server configured (INFERENCE_URL).'
            : p.inferenceReady
              ? device?.online ? `Server model: ${device.model}` : 'Inference server configured.'
              : 'Checking inference server…'}
        </p>
        <label className="field">Label scheme
          <select id="scheme" value={p.scheme} onChange={(e) => p.onScheme(e.target.value as Scheme)}>
            {(Object.keys(SCHEME_NAMES) as Scheme[]).map((k) => <option key={k} value={k}>{SCHEME_NAMES[k]}</option>)}
          </select>
        </label>
        <div className="labels">
          {!p.mask && <p className="note">No mask loaded.</p>}
          {Object.entries(p.labels).map(([L, d]) => (
            <div className="lab" key={L}>
              <input type="checkbox" checked={d.visible} aria-label={`Show ${d.name}`} onChange={(e) => p.onLabel(+L, { visible: e.target.checked })} />
              <span className="sw" style={{ background: `rgb(${d.color.join(',')})` }} />
              <input id={`lname-${L}`} type="text" value={d.name} aria-label={`Label ${L} name`} onChange={(e) => p.onLabel(+L, { name: e.target.value })} />
              <select aria-label={`Label ${L} role`} value={d.role} onChange={(e) => p.onLabel(+L, { role: e.target.value as Role })}>
                {(Object.keys(ROLES) as Role[]).map((r) => <option key={r} value={r}>{ROLES[r]}</option>)}
              </select>
            </div>
          ))}
        </div>
        {p.mask?.source === 'threshold' && <p className="note warn">The threshold map also captures organs and the table. Replace it with a model mask before reporting.</p>}
      </section>

      <section className="sec">
        <h2>3 · Viewer controls</h2>
        {p.vol && (
          <label className="field">Axial scrub <span className="mono">{p.cur.k + 1} / {p.vol.nz}{p.l3 === p.cur.k ? ' · L3' : ''}</span>
            <input id="scrub" type="range" min={0} max={p.vol.nz - 1} value={p.cur.k} onChange={(e) => p.onAxialScrub(+e.target.value)} />
          </label>
        )}
        <label className="field">Mask opacity <span className="mono">{Math.round(p.opacity * 100)}%</span>
          <input id="opacity" type="range" min={0} max={100} value={Math.round(p.opacity * 100)} onChange={(e) => p.onOpacity(+e.target.value / 100)} />
        </label>
        <div className="chips">
          {PRESETS.map(([n, w, l]) => (
            <button type="button" key={n} className="chip" aria-pressed={p.wl.w === w && p.wl.l === l} onClick={() => p.onWL({ w, l })}>{n}<small>{w}/{l}</small></button>
          ))}
        </div>
        <div className="grid2">
          <label className="field">Width (HU)<input id="wl-w" type="number" step={10} value={p.wl.w} onChange={(e) => p.onWL({ ...p.wl, w: Math.max(1, +e.target.value || 1) })} /></label>
          <label className="field">Level (HU)<input id="wl-l" type="number" step={5} value={p.wl.l} onChange={(e) => p.onWL({ ...p.wl, l: +e.target.value || 0 })} /></label>
        </div>
        <div className="seg">
          {TOOLS.map(([t, n]) => <button type="button" key={t} aria-pressed={p.tool === t} onClick={() => p.onTool(t)}>{n}</button>)}
        </div>
        <div className="row">
          <button type="button" className="btn small" onClick={p.onResetViews}>Reset views</button>
          <button type="button" className="btn small" onClick={p.onClearMeas}>Clear measurements</button>
        </div>
        <p className="note"><kbd>wheel</kbd> slice · <kbd>Ctrl</kbd>+<kbd>wheel</kbd> zoom · right-drag W/L · middle-drag pan</p>
      </section>

      <section className="sec">
        <h2>L3 landmark</h2>
        <div className="row">
          <button type="button" className="btn small" onClick={p.onSetL3} disabled={!p.vol}>Set L3 at current axial</button>
          <button type="button" className="btn small" onClick={p.onGoL3} disabled={p.l3 == null}>Go to L3</button>
        </div>
        <p className="status">{p.l3 != null ? `L3 at axial slice ${p.l3 + 1}` : 'Not set'}</p>
      </section>

      <section className="sec">
        <h2>Patient</h2>
        <div className="grid2">
          <label className="field">Sex
            <select id="p-sex" value={p.patient.sex} onChange={(e) => p.onPatient({ ...p.patient, sex: e.target.value as Patient['sex'] })}>
              <option value="">–</option><option value="M">Male</option><option value="F">Female</option>
            </select>
          </label>
          <label className="field">Age<input id="p-age" type="number" min={0} max={120} value={p.patient.age} onChange={(e) => p.onPatient({ ...p.patient, age: e.target.value })} /></label>
          <label className="field">Height cm<input id="p-h" type="number" min={50} max={250} value={p.patient.heightCm} onChange={(e) => p.onPatient({ ...p.patient, heightCm: e.target.value })} /></label>
          <label className="field">Weight kg<input id="p-w" type="number" min={10} max={400} step={0.1} value={p.patient.weightKg} onChange={(e) => p.onPatient({ ...p.patient, weightKg: e.target.value })} /></label>
        </div>
        <p className="status">{b ? `BMI ${b.toFixed(1)} kg/m²` : 'Sex, height and weight are needed for index cut-offs.'}</p>
      </section>

      <section className="sec">
        <h2>4 · Report endpoint</h2>
        <p className="status">
          <span className={`led ${p.llm?.configured ? 'on' : ''}`} />
          {p.llm == null ? 'Checking…' : p.llm.configured ? `${p.llm.model}` : 'No language model · rule-based drafts'}
        </p>
        <button type="button" className="btn" onClick={p.onGenerate} disabled={!p.canReport}>{p.reportBusy ? 'Generating…' : p.llm?.configured ? 'Generate AI report' : 'Generate draft report'}</button>
      </section>

      <section className="sec">
        <h2>Device status</h2>
        {!device ? (
          <p className="status">Checking…</p>
        ) : !device.configured ? (
          <p className="note">No inference server configured.</p>
        ) : !device.online ? (
          <p className="status err"><span className="led bad" />Offline{device.error ? ` · ${device.error}` : ''}</p>
        ) : (
          <>
            <p className="status"><span className={`led ${device.busy ? 'mid' : 'on'}`} />{device.device} · {device.busy ? 'running' : 'ready'}</p>
            <dl className="kv">
              <dt>Memory</dt><dd>{device.mem_used_mb != null ? `${(device.mem_used_mb / 1024).toFixed(1)} / ${((device.mem_total_mb ?? 0) / 1024).toFixed(1)} GB` : '–'}</dd>
              <dt>{device.gpu_util != null ? 'GPU' : 'CPU'}</dt><dd>{device.gpu_util ?? device.cpu_util ?? '–'}%</dd>
              <dt>Temp</dt><dd>{device.temp_c != null ? `${device.temp_c} °C` : '–'}</dd>
              <dt>Power</dt><dd>{device.power_w != null ? `${device.power_w.toFixed(1)} W` : '–'}</dd>
            </dl>
            {memPct != null && <div className="meter" role="meter" aria-valuenow={Math.round(memPct)} aria-valuemin={0} aria-valuemax={100} aria-label="Memory used"><span style={{ width: `${memPct}%` }} /></div>}
          </>
        )}
      </section>
    </aside>
  );
}
