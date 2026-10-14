'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import AIReport from './AIReport';
import InfoPanel from './InfoPanel';
import MetricsTable from './MetricsTable';
import Overview from './Overview';
import RunLog from './RunLog';
import Sidebar, { type CaseEntry } from './Sidebar';
import TransmittedJson from './TransmittedJson';
import Viewport from './Viewport';
import type { Analysis, DraftReport, RunRecord } from '@/lib/analysis';
import { metricsCsv } from '@/lib/csv';
import { downloadText } from '@/lib/download';
import { labelsFor, ROLE_COLOR, thresholdMask } from '@/lib/labels';
import { countLabels, readNifti, toMask, toVolume } from '@/lib/nifti';
import { buildPayload, caseRef, ruleNarrative } from '@/lib/payload';
import { makePhantom } from '@/lib/phantom';
import type { GeneratedReport, Narrative, SignatureResult } from '@/lib/report-types';
import { sessionLog } from '@/lib/session-log';
import type {
  Cursor, LabelMap, MaskState, Measurement, Patient, Role, SchemeKey, Tool, ViewName, Volume, WindowLevel,
} from '@/lib/types';
import { buildLut, stepCursor } from '@/lib/views';
import { volumeStats } from '@/lib/volumetrics';

const VIEWS: ViewName[] = ['axial', 'coronal', 'sagittal'];
const TABS = [
  ['overview', 'Overview'],
  ['viewer', 'Slice viewer'],
  ['metrics', 'Metrics table'],
  ['report', 'AI report'],
  ['json', 'Transmitted JSON'],
  ['log', 'Run log'],
] as const;
type Tab = (typeof TABS)[number][0];

const isMaskName = (n: string) => /(seg|mask|label|lbl)/i.test(n);
const tick = () => new Promise((r) => setTimeout(r, 16));
const EMPTY_PATIENT: Patient = { sex: '', age: '', heightCm: '', weightKg: '' };
const log = sessionLog.add;

async function errorText(res: Response) {
  const t = await res.text();
  return t || `HTTP ${res.status}`;
}

export default function Workstation() {
  const [tab, setTab] = useState<Tab>('overview');
  const [theme, setTheme] = useState<'light' | 'dark' | null>(null);
  const [vol, setVol] = useState<Volume | null>(null);
  const [ctName, setCtName] = useState('');
  const [ctFile, setCtFile] = useState<File | null>(null);
  const [sample, setSample] = useState(false);
  const [mask, setMask] = useState<MaskState | null>(null);
  const [labels, setLabels] = useState<LabelMap>({});
  const [scheme, setScheme] = useState<Exclude<SchemeKey, 'threshold'>>('generic');
  const [cur, setCur] = useState<Cursor>({ i: 0, j: 0, k: 0 });
  const [wl, setWl] = useState<WindowLevel>({ w: 400, l: 40 });
  const [opacity, setOpacity] = useState(0.45);
  const [tool, setTool] = useState<Tool>('cross');
  const [meas, setMeas] = useState<Measurement[]>([]);
  const [l3, setL3] = useState<number | null>(null);
  const [patient, setPatient] = useState<Patient>(EMPTY_PATIENT);
  const [status, setStatus] = useState<{ text: string; error?: boolean }>({ text: '' });
  const [busy, setBusy] = useState(false);
  const [reportBusy, setReportBusy] = useState(false);
  const [resetToken, setResetToken] = useState(0);
  const [dragging, setDragging] = useState(false);
  const [inferenceReady, setInferenceReady] = useState<boolean | null>(null);
  const [llm, setLlm] = useState<{ configured: boolean; model: string | null } | null>(null);
  const [cases, setCases] = useState<{ configured: boolean; cases: CaseEntry[]; error?: string } | null>(null);
  const [pendingMask, setPendingMask] = useState<File | null>(null);
  const [ref, setRef] = useState('');
  const [report, setReport] = useState<DraftReport | null>(null);
  const [signature, setSignature] = useState<SignatureResult | null>(null);
  const [run, setRun] = useState<RunRecord | null>(null);
  const measId = useRef(1);

  const lut = useMemo(() => buildLut(wl.w, wl.l), [wl.w, wl.l]);
  const stats = useMemo(() => (vol && mask ? volumeStats(vol, mask.data) : null), [vol, mask]);

  useEffect(() => {
    let cancelled = false;
    caseRef(ctName || 'none').then((r) => !cancelled && setRef(r));
    return () => {
      cancelled = true;
    };
  }, [ctName]);

  const payload = useMemo(
    () => (vol && ref ? buildPayload({ ref, vol, mask, labels, scheme, stats, patient, l3, sample }) : null),
    [ref, vol, mask, labels, scheme, stats, patient, l3, sample],
  );
  const payloadKey = useMemo(() => (payload ? JSON.stringify(payload) : ''), [payload]);

  // ---- theme ----
  useEffect(() => {
    try {
      const t = localStorage.getItem('bodycomp-theme');
      if (t === 'light' || t === 'dark') setTheme(t);
      const savedTab = localStorage.getItem('bodycomp-tab');
      if (savedTab && TABS.some(([k]) => k === savedTab)) setTab(savedTab as Tab);
    } catch {}
  }, []);
  useEffect(() => {
    if (theme) document.documentElement.dataset.theme = theme;
    else delete document.documentElement.dataset.theme;
  }, [theme]);
  const toggleTheme = () => {
    const dark = theme ? theme === 'dark' : window.matchMedia('(prefers-color-scheme: dark)').matches;
    const next = dark ? 'light' : 'dark';
    setTheme(next);
    try { localStorage.setItem('bodycomp-theme', next); } catch {}
  };
  const chooseTab = (t: Tab) => {
    setTab(t);
    try { localStorage.setItem('bodycomp-tab', t); } catch {}
  };

  // ---- loading ----
  const openVolume = useCallback((v: Volume, name: string, isSample: boolean, file: File | null) => {
    setVol(v);
    setCtName(name);
    setCtFile(file);
    setSample(isSample);
    setMask(null);
    setLabels({});
    setMeas([]);
    setL3(null);
    setReport(null);
    setSignature(null);
    setRun(null);
    setCur({ i: v.nx >> 1, j: v.ny >> 1, k: v.nz >> 1 });
    setResetToken((t) => t + 1);
  }, []);

  const applyMask = useCallback((data: Uint8Array, name: string, source: MaskState['source'], key: SchemeKey) => {
    const counts = countLabels(data);
    setMask({ data, name, source, counts });
    setLabels(labelsFor(counts, key));
    if (key !== 'threshold') setScheme(key);
    const present = [...counts.keys()].filter((L) => L && counts[L]).length;
    log('INFO', 'MASK', `${name}: ${present} labels (${source}, ${key} scheme)`);
  }, []);

  const loadSample = useCallback(() => {
    setStatus({ text: 'Building sample phantom…' });
    setTimeout(() => {
      const t0 = performance.now();
      const { vol: v, mask: m, l3: l } = makePhantom();
      openVolume(v, 'sample_phantom_T12-L4.nii.gz', true, null);
      applyMask(m, 'sample_phantom_seg.nii.gz', 'sample', 'generic');
      setL3(l);
      setCur({ i: v.nx >> 1, j: v.ny >> 1, k: l });
      setPatient({ sex: 'M', age: '64', heightCm: '172', weightKg: '68' });
      setStatus({ text: 'Sample loaded. Example patient values filled in.' });
      log('INFO', 'SAMPLE', `synthetic phantom ${v.nx}×${v.ny}×${v.nz} built in ${(performance.now() - t0).toFixed(0)} ms`);
    }, 20);
  }, [openVolume, applyMask]);

  useEffect(() => {
    loadSample();
    const j = (u: string) => fetch(u, { cache: 'no-store' }).then((r) => r.json());
    j('/api/segment').then((r: { configured: boolean }) => setInferenceReady(r.configured)).catch(() => setInferenceReady(false));
    j('/api/report').then(setLlm).catch(() => setLlm({ configured: false, model: null }));
    j('/api/cases').then(setCases).catch(() => setCases({ configured: false, cases: [] }));
  }, [loadSample]);

  const loadCT = useCallback(
    async (file: File) => {
      try {
        setBusy(true);
        setStatus({ text: `Reading ${file.name}…` });
        await tick();
        const t0 = performance.now();
        const v = toVolume(await readNifti(file));
        openVolume(v, file.name, false, file);
        setPatient(EMPTY_PATIENT);
        setStatus({ text: `Loaded ${file.name}` });
        log('INFO', 'LOAD', `${file.name}: ${(file.size / 1e6).toFixed(1)} MB, ${v.nx}×${v.ny}×${v.nz} at ${v.sx.toFixed(2)}×${v.sy.toFixed(2)}×${v.sz.toFixed(2)} mm (${v.src}) in ${(performance.now() - t0).toFixed(0)} ms`);
      } catch (err) {
        setStatus({ text: (err as Error).message, error: true });
        log('ERROR', 'LOAD', `${file.name}: ${(err as Error).message}`);
      } finally {
        setBusy(false);
      }
    },
    [openVolume],
  );

  const loadMaskBuffer = useCallback(
    async (input: Blob | ArrayBuffer, name: string, source: MaskState['source'], key: SchemeKey) => {
      if (!vol) throw new Error('Open the CT before its mask.');
      const m = toMask(await readNifti(input));
      if (m.nx !== vol.nx || m.ny !== vol.ny || m.nz !== vol.nz) {
        throw new Error(`Mask grid ${m.nx}×${m.ny}×${m.nz} does not match CT ${vol.nx}×${vol.ny}×${vol.nz}. Resample the mask to the CT grid.`);
      }
      applyMask(m.data, name, source, key);
    },
    [vol, applyMask],
  );

  const loadMask = useCallback(
    async (file: File) => {
      try {
        setBusy(true);
        setStatus({ text: `Reading ${file.name}…` });
        await tick();
        await loadMaskBuffer(file, file.name, 'file', scheme);
        setStatus({ text: `Loaded mask ${file.name}` });
      } catch (err) {
        setStatus({ text: (err as Error).message, error: true });
        log('ERROR', 'MASK', (err as Error).message);
      } finally {
        setBusy(false);
      }
    },
    [loadMaskBuffer, scheme],
  );

  useEffect(() => {
    if (pendingMask && vol) {
      const f = pendingMask;
      setPendingMask(null);
      void loadMask(f);
    }
  }, [pendingMask, vol, loadMask]);

  const openCase = useCallback(
    async (c: CaseEntry) => {
      const get = async (name: string) => {
        const r = await fetch(`/api/cases/${encodeURIComponent(name)}`, { cache: 'no-store' });
        if (!r.ok) throw new Error(await errorText(r));
        return new File([await r.blob()], name);
      };
      try {
        setBusy(true);
        setStatus({ text: `Fetching ${c.name} from the case library…` });
        const ct = await get(c.name);
        const mk = c.mask ? await get(c.mask) : null;
        setBusy(false);
        await loadCT(ct);
        if (mk) setPendingMask(mk);
      } catch (err) {
        setStatus({ text: (err as Error).message, error: true });
        setBusy(false);
      }
    },
    [loadCT],
  );

  const fetchRun = useCallback(async (id: string) => {
    try {
      const r = await fetch(`/api/runs/${id}`, { cache: 'no-store' });
      if (r.ok) setRun((await r.json()) as RunRecord);
      else log('WARN', 'RUNLOG', `could not fetch run ${id}: ${await errorText(r)}`);
    } catch (err) {
      log('WARN', 'RUNLOG', (err as Error).message);
    }
  }, []);

  const runSegmentation = useCallback(async () => {
    if (!ctFile) {
      setStatus({ text: 'Open a CT file first. The sample phantom already has a mask.', error: true });
      return;
    }
    const t0 = performance.now();
    try {
      setBusy(true);
      setStatus({ text: `Sending ${ctFile.name} to the segmentation server…` });
      log('INFO', 'INFERENCE', `uploading ${ctFile.name} (${(ctFile.size / 1e6).toFixed(1)} MB)`);
      const res = await fetch('/api/segment', {
        method: 'POST',
        headers: { 'Content-Type': 'application/octet-stream', 'X-Filename': encodeURIComponent(ctFile.name) },
        body: ctFile,
      });
      const runId = res.headers.get('x-run-id');
      if (!res.ok) {
        if (runId) void fetchRun(runId);
        throw new Error(await errorText(res));
      }
      setStatus({ text: 'Reading returned mask…' });
      const returned = res.headers.get('x-label-scheme');
      const key: SchemeKey = returned === 'totalseg' || returned === 'generic' ? returned : scheme;
      await loadMaskBuffer(await res.arrayBuffer(), `${ctName.replace(/\.nii(\.gz)?$/i, '')}_seg.nii.gz`, 'inference', key);
      setReport(null);
      setSignature(null);
      setStatus({ text: 'Segmentation complete. Check the mask before setting L3.' });
      log('SUCCESS', 'INFERENCE', `mask received in ${((performance.now() - t0) / 1000).toFixed(1)} s${runId ? ` (run ${runId})` : ''}`);
      if (runId) void fetchRun(runId);
    } catch (err) {
      setStatus({ text: (err as Error).message, error: true });
      log('ERROR', 'INFERENCE', (err as Error).message);
    } finally {
      setBusy(false);
    }
  }, [ctFile, ctName, loadMaskBuffer, scheme, fetchRun]);

  const buildThreshold = useCallback(() => {
    if (!vol) return;
    applyMask(thresholdMask(vol.data), 'HU threshold map', 'threshold', 'threshold');
    setStatus({ text: 'Threshold map built for the whole volume.' });
  }, [vol, applyMask]);

  // ---- report ----
  const generate = useCallback(async () => {
    if (!payload) return;
    setReportBusy(true);
    setSignature(null);
    const key = payloadKey;
    try {
      const rules = (fallbackReason?: string): GeneratedReport => ({
        source: 'rules', generatedAt: new Date().toISOString(), narrative: ruleNarrative(payload), unverifiedNumbers: [], fallbackReason,
      });
      let g: GeneratedReport;
      if (llm?.configured) {
        log('INFO', 'REPORT', `sending ${new Blob([key]).size} bytes of de-identified metrics to ${llm.model}`);
        try {
          const r = await fetch('/api/report', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: key });
          if (!r.ok) throw new Error(await errorText(r));
          g = (await r.json()) as GeneratedReport;
          log('SUCCESS', 'REPORT', `draft received in ${g.latencyMs} ms${(g.attempts ?? 1) > 1 ? ' after a retry' : ''}${g.unverifiedNumbers.length ? `; ${g.unverifiedNumbers.length} unverified numbers` : ''}`);
        } catch (err) {
          // Keep the workflow moving: fall back to the rule-based draft and say why.
          const reason = (err as Error).message;
          g = rules(reason);
          log('WARN', 'REPORT', `${llm.model} failed (${reason.slice(0, 200)}); rule-based draft written instead`);
        }
      } else {
        g = rules();
        log('INFO', 'REPORT', 'rule-based draft written (no language model configured)');
      }
      setReport({ ...g, payloadKey: key, edited: false });
      setStatus({ text: g.fallbackReason ? 'Model unavailable; rule-based draft ready for review.' : 'Draft report ready for review.' });
    } catch (err) {
      setStatus({ text: (err as Error).message, error: true });
      log('ERROR', 'REPORT', (err as Error).message);
    } finally {
      setReportBusy(false);
    }
  }, [payload, payloadKey, llm]);

  const editNarrative = (n: Narrative) => setReport((r) => (r ? { ...r, narrative: n, edited: true } : r));

  const sign = useCallback(
    async (reader: string, remarks: string): Promise<string | null> => {
      if (!report || !payload) return 'Nothing to sign.';
      setReportBusy(true);
      try {
        const r = await fetch('/api/sign', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ payload, report, reader, remarks, decision: report.edited ? 'amended' : 'approved' }),
        });
        if (!r.ok) return await errorText(r);
        const s = (await r.json()) as SignatureResult;
        setSignature(s);
        log('SUCCESS', 'SIGN', `signed by ${reader}; sha256 ${s.sha256.slice(0, 16)}…; stored ${s.file}`);
        return null;
      } catch (err) {
        return (err as Error).message;
      } finally {
        setReportBusy(false);
      }
    },
    [report, payload],
  );

  const print = () => {
    chooseTab('report');
    setTimeout(() => window.print(), 150);
  };

  const exportCsv = () => {
    if (!vol || !mask || !stats) return;
    downloadText(metricsCsv({ caseRef: ref, vol, mask, labels, stats, patient, l3 }), `${ref}_metrics.csv`, 'text/csv');
  };

  // ---- labels and navigation ----
  const changeScheme = (key: Exclude<SchemeKey, 'threshold'>) => {
    setScheme(key);
    if (mask && mask.source !== 'threshold') setLabels(labelsFor(mask.counts, key));
  };
  const updateLabel = (L: number, patch: Partial<{ visible: boolean; name: string; role: Role }>) => {
    setLabels((prev) => {
      const next = { ...prev[L], ...patch };
      if (patch.role) next.color = ROLE_COLOR[patch.role];
      return { ...prev, [L]: next };
    });
  };
  const onStep = useCallback((name: ViewName, d: number) => setCur((c) => (vol ? stepCursor(vol, name, c, d) : c)), [vol]);
  const onAddMeas = useCallback((m: Omit<Measurement, 'id'>) => setMeas((prev) => [...prev, { ...m, id: measId.current++ }]), []);

  // ---- drag and drop ----
  useEffect(() => {
    let depth = 0;
    const enter = (e: DragEvent) => {
      if (e.dataTransfer?.types.includes('Files')) {
        depth++;
        setDragging(true);
      }
    };
    const leave = () => {
      depth = Math.max(0, depth - 1);
      if (!depth) setDragging(false);
    };
    const over = (e: DragEvent) => e.preventDefault();
    const drop = async (e: DragEvent) => {
      e.preventDefault();
      depth = 0;
      setDragging(false);
      const files = [...(e.dataTransfer?.files ?? [])].filter((f) => /\.nii(\.gz)?$/i.test(f.name));
      if (!files.length) {
        setStatus({ text: 'Drop .nii or .nii.gz files.', error: true });
        return;
      }
      const ct = files.find((f) => !isMaskName(f.name));
      const mk = files.find((f) => isMaskName(f.name));
      if (ct) await loadCT(ct);
      if (mk) setPendingMask(mk);
    };
    window.addEventListener('dragenter', enter);
    window.addEventListener('dragleave', leave);
    window.addEventListener('dragover', over);
    window.addEventListener('drop', drop);
    return () => {
      window.removeEventListener('dragenter', enter);
      window.removeEventListener('dragleave', leave);
      window.removeEventListener('dragover', over);
      window.removeEventListener('drop', drop);
    };
  }, [loadCT]);

  const a: Analysis = { vol, ctName, sample, mask, labels, scheme, stats, patient, l3, cur, wl, lut, payload, payloadKey, report, signature, run, llm };

  const viewport = (name: ViewName, title?: string) => (
    <Viewport
      key={name}
      name={name}
      title={title}
      vol={vol}
      mask={mask?.data ?? null}
      labels={labels}
      lut={lut}
      cur={cur}
      wl={wl}
      opacity={opacity}
      tool={tool}
      meas={meas}
      l3={l3}
      resetToken={resetToken}
      onCursor={setCur}
      onStep={onStep}
      onWL={setWl}
      onAddMeas={onAddMeas}
    />
  );

  const segState = mask ? (mask.source === 'threshold' ? 'Threshold map' : mask.source === 'sample' ? 'Sample mask' : 'Mask loaded') : busy ? 'Running…' : 'No mask';
  const repState = signature ? 'Signed' : report ? (report.payloadKey !== payloadKey ? 'Draft · out of date' : 'Draft') : 'Not started';

  return (
    <div className="app">
      <header className="top">
        <div className="brand">
          <b>BodyComp</b>
          <span>CT body composition</span>
        </div>
        <div className="case">
          {vol ? (
            <>
              <strong>{ctName}</strong>
              <span>{vol.nx}×{vol.ny}×{vol.nz} · {vol.sx.toFixed(2)}×{vol.sy.toFixed(2)}×{vol.sz.toFixed(2)} mm</span>
              {sample && <span className="tag sample">Synthetic phantom · not patient data</span>}
            </>
          ) : (
            <span>No study open</span>
          )}
        </div>
        <div className="chips-top">
          <span className={`chip-s ${mask ? 'on' : ''}`}><em>Segmentation</em>{segState}</span>
          <span className={`chip-s ${signature ? 'on' : report ? 'mid' : ''}`}><em>Report</em>{repState}</span>
          <button type="button" className="btn small" onClick={toggleTheme} aria-label="Switch light or dark theme">Theme</button>
        </div>
      </header>

      <Sidebar
        vol={vol}
        ctName={ctName}
        mask={mask}
        labels={labels}
        scheme={scheme}
        wl={wl}
        opacity={opacity}
        tool={tool}
        l3={l3}
        cur={cur}
        patient={patient}
        status={status}
        busy={busy}
        canSegment={!!ctFile && inferenceReady === true}
        inferenceReady={inferenceReady}
        cases={cases}
        llm={llm}
        canReport={!!payload && !reportBusy}
        reportBusy={reportBusy}
        onOpenCase={openCase}
        onOpenCT={loadCT}
        onOpenMask={loadMask}
        onSample={loadSample}
        onSegment={runSegmentation}
        onThreshold={buildThreshold}
        onScheme={changeScheme}
        onLabel={updateLabel}
        onWL={setWl}
        onOpacity={setOpacity}
        onTool={setTool}
        onResetViews={() => setResetToken((t) => t + 1)}
        onClearMeas={() => setMeas([])}
        onSetL3={() => setL3(cur.k)}
        onGoL3={() => l3 != null && setCur((c) => ({ ...c, k: l3 }))}
        onAxialScrub={(k) => setCur((c) => ({ ...c, k }))}
        onPatient={setPatient}
        onGenerate={() => { void generate(); chooseTab('report'); }}
      />

      <div className="main">
        <nav className="tabs-main no-print" role="tablist">
          {TABS.map(([k, n]) => (
            <button type="button" role="tab" key={k} aria-selected={tab === k} className="tab-main" onClick={() => chooseTab(k)}>{n}</button>
          ))}
        </nav>
        <div className="tab-panel">
          {tab === 'overview' && <Overview a={a} viewport={viewport('axial', 'Axial')} onGenerate={generate} onPrint={print} onCsv={exportCsv} busy={reportBusy} />}
          {tab === 'viewer' && (
            <main className="grid">
              {VIEWS.map((n) => viewport(n))}
              <InfoPanel
                vol={vol}
                ctName={ctName}
                sample={sample}
                mask={mask}
                labels={labels}
                scheme={scheme}
                patient={patient}
                l3={l3}
                cur={cur}
                meas={meas}
                onGoMeas={(m) => setCur((c) => (m.view === 'axial' ? { ...c, k: m.slice } : m.view === 'coronal' ? { ...c, j: m.slice } : { ...c, i: m.slice }))}
                onDeleteMeas={(id) => setMeas((prev) => prev.filter((m) => m.id !== id))}
              />
            </main>
          )}
          {tab === 'metrics' && <MetricsTable a={a} onCsv={exportCsv} onPickSlice={(k) => setCur((c) => ({ ...c, k }))} />}
          {tab === 'report' && <AIReport a={a} busy={reportBusy} onGenerate={generate} onPrint={print} onEdit={editNarrative} onSign={sign} />}
          {tab === 'json' && <TransmittedJson a={a} />}
          {tab === 'log' && <RunLog a={a} onRefresh={() => run && fetchRun(run.id)} />}
        </div>
      </div>

      {dragging && <div className="drop">Drop .nii / .nii.gz files</div>}
    </div>
  );
}
