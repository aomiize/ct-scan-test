import { evaluate, roleMetrics, sliceStats } from './metrics';
import { bmiOf, isFlagged, REFERENCE } from './reference';
import type { AnalysisPayload, Narrative } from './report-types';
import type { LabelMap, MaskState, Patient, Volume } from './types';
import { roleVolumes, type VolumeStats } from './volumetrics';

const r1 = (v: number | null | undefined) => (v == null || !isFinite(v) ? null : Math.round(v * 10) / 10);
const r2 = (v: number | null | undefined) => (v == null || !isFinite(v) ? null : Math.round(v * 100) / 100);

export async function caseRef(caseId: string): Promise<string> {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(caseId));
  return 'case-' + [...new Uint8Array(buf)].slice(0, 6).map((b) => b.toString(16).padStart(2, '0')).join('');
}

export function buildPayload(x: {
  ref: string;
  vol: Volume;
  mask: MaskState | null;
  labels: LabelMap;
  scheme: string;
  stats: VolumeStats | null;
  patient: Patient;
  l3: number | null;
  sample: boolean;
}): AnalysisPayload {
  const { vol, mask, patient: p } = x;
  const b = bmiOf(p);
  const ev = mask && x.l3 != null ? evaluate(roleMetrics(vol, x.labels, sliceStats(vol, mask.data, x.l3)), p) : null;
  const rv = x.stats ? roleVolumes(vol, x.labels, x.stats) : null;
  const adipose = rv ? rv.sat.cm3 + rv.vat.cm3 + rv.imat.cm3 : null;
  const tissue = rv && adipose != null ? adipose + rv.muscle.cm3 : null;

  const refs: AnalysisPayload['references'] = [];
  const push = (metric: string, value: number | null, c: ReturnType<typeof REFERENCE.smi>) => {
    if (c) refs.push({ metric, cutoff: c.value, flag_when: c.flagWhen, flagged: isFlagged(value, c), source: c.source });
  };
  if (ev) {
    push('skeletal_muscle_index_cm2_m2', ev.smi, REFERENCE.smi(p));
    push('muscle_mean_hu', ev.muscleHU, REFERENCE.smra(p));
    push('vat_area_cm2', ev.vat, REFERENCE.vatArea(p));
  }

  const flags: string[] = [];
  if (x.sample) flags.push('synthetic phantom, not patient data');
  if (!mask) flags.push('no segmentation loaded');
  else if (mask.source === 'threshold') flags.push('HU threshold map: includes organs and table, areas overestimated');
  if (mask && x.l3 == null) flags.push('L3 slice not set');
  if (!p.sex || b == null) flags.push('sex, height or weight missing: index cut-offs not applied');

  const st = x.stats;
  return {
    schema: 'bodycomp.metrics/v1',
    case_ref: x.ref,
    synthetic_sample: x.sample,
    scan: {
      axial_slices: vol.nz,
      spacing_mm: [r2(vol.sx)!, r2(vol.sy)!, r2(vol.sz)!],
      segmented_slices: st && st.kMin >= 0 ? [st.kMin, st.kMax] : null,
      segmented_extent_mm: st && st.kMin >= 0 ? r1((st.kMax - st.kMin + 1) * vol.sz) : null,
    },
    segmentation: { source: mask?.source ?? 'none', scheme: mask?.source === 'threshold' ? 'threshold' : x.scheme },
    patient: {
      sex: p.sex || null,
      age_years: +p.age > 0 ? +p.age : null,
      height_cm: +p.heightCm || null,
      weight_kg: +p.weightKg || null,
      bmi: r1(b),
    },
    l3: ev
      ? {
          slice_index: x.l3!,
          skeletal_muscle_area_cm2: r1(ev.sma),
          skeletal_muscle_index_cm2_m2: r1(ev.smi),
          muscle_mean_hu: r1(ev.muscleHU),
          vat_area_cm2: r1(ev.vat),
          sat_area_cm2: r1(ev.sat),
          imat_area_cm2: r1(ev.imat),
          vat_sat_ratio: r2(ev.vatSat),
        }
      : null,
    volumes_segmented_range: rv
      ? {
          muscle_cm3: r1(rv.muscle.cm3),
          muscle_mean_hu: r1(rv.muscle.meanHU),
          sat_cm3: r1(rv.sat.cm3),
          vat_cm3: r1(rv.vat.cm3),
          imat_cm3: r1(rv.imat.cm3),
          adipose_total_cm3: r1(adipose),
          adipose_share_pct: tissue ? r1((adipose! / tissue) * 100) : null,
        }
      : null,
    references: refs,
    quality_flags: flags,
  };
}

/** Deterministic narrative used when no language model is configured. Uses only payload values. */
export function ruleNarrative(pl: AnalysisPayload): Narrative {
  const l = pl.l3, v = pl.volumes_segmented_range;
  const ref = (m: string) => pl.references.find((r) => r.metric === m);
  const fmt = (x: number | null | undefined, u: string) => (x == null ? 'not available' : `${x} ${u}`);
  const smi = ref('skeletal_muscle_index_cm2_m2'), hu = ref('muscle_mean_hu'), vat = ref('vat_area_cm2');

  const findings: string[] = [];
  if (smi?.flagged) findings.push('low skeletal muscle index');
  if (hu?.flagged) findings.push('low muscle attenuation');
  if (vat?.flagged) findings.push('visceral fat area above the reference cut-off');

  const summary = !l
    ? 'L3 metrics are not available yet. Load a segmentation and set the L3 slice.'
    : findings.length
      ? `At L3 the measurements show ${findings.join(', ')}. ${smi?.flagged && vat?.flagged ? 'Low muscle mass together with visceral obesity is consistent with a sarcopenic obesity pattern; clinical correlation is required.' : 'Clinical correlation is required.'}`
      : 'At L3 the measured values are within the configured reference cut-offs.';

  const examination = `${pl.scan.axial_slices} axial slices at ${pl.scan.spacing_mm.join(' × ')} mm. Segmentation source: ${pl.segmentation.source} (${pl.segmentation.scheme} labels)${pl.scan.segmented_extent_mm ? `, covering ${pl.scan.segmented_extent_mm} mm craniocaudally` : ''}.${l ? ` L3 analysed on axial slice ${l.slice_index + 1}.` : ''}`;

  const muscle = l
    ? `Skeletal muscle area ${fmt(l.skeletal_muscle_area_cm2, 'cm²')}, skeletal muscle index ${fmt(l.skeletal_muscle_index_cm2_m2, 'cm²/m²')}${smi ? ` (cut-off ${smi.flag_when === 'below' ? '<' : '>'}${smi.cutoff}; ${smi.flagged ? 'below' : 'not below'})` : ''}. Mean muscle attenuation ${fmt(l.muscle_mean_hu, 'HU')}${hu ? ` (cut-off <${hu.cutoff}; ${hu.flagged ? 'below' : 'not below'})` : ''}.${v?.muscle_cm3 != null ? ` Muscle volume over the segmented range ${v.muscle_cm3} cm³.` : ''}`
    : 'Not available.';

  const adipose = l
    ? `Visceral fat area ${fmt(l.vat_area_cm2, 'cm²')}${vat ? ` (cut-off >${vat.cutoff}; ${vat.flagged ? 'above' : 'not above'})` : ''}, subcutaneous fat area ${fmt(l.sat_area_cm2, 'cm²')}, intermuscular fat area ${fmt(l.imat_area_cm2, 'cm²')}, VAT/SAT ratio ${fmt(l.vat_sat_ratio, '')}.${v?.adipose_total_cm3 != null ? ` Total adipose volume over the segmented range ${v.adipose_total_cm3} cm³ (${v.adipose_share_pct}% of segmented tissue).` : ''}`
    : 'Not available.';

  const recommendations: string[] = [];
  if (smi?.flagged || hu?.flagged) recommendations.push('Consider nutritional and physical-function assessment for low muscle mass or quality.');
  if (vat?.flagged) recommendations.push('Consider cardiometabolic risk assessment in the context of visceral obesity.');
  if (l) recommendations.push('Repeat body-composition measurement on follow-up imaging to track change.');

  return {
    summary,
    examination,
    muscle,
    adipose,
    recommendations,
    limitations: ['Automated segmentation must be reviewed by a qualified reader.', ...pl.quality_flags.map((f) => `Note: ${f}.`)].join(' '),
  };
}

/** Find numbers in text that do not appear in the payload (tolerating rounding). */
export function unverifiedNumbers(text: string, pl: AnalysisPayload): string[] {
  const known: number[] = [];
  const walk = (o: unknown) => {
    if (typeof o === 'number') known.push(o);
    else if (Array.isArray(o)) o.forEach(walk);
    else if (o && typeof o === 'object') Object.values(o).forEach(walk);
  };
  walk(pl);
  if (pl.l3) known.push(pl.l3.slice_index + 1, 3);
  const found = text.match(/-?\d+(?:\.\d+)?/g) ?? [];
  const out = new Set<string>();
  for (const s of found) {
    const x = parseFloat(s);
    if (!isFinite(x)) continue;
    if (Math.abs(x) <= 10 && Number.isInteger(x)) continue; // counts, list numbers, "L3", "6 months"
    const ok = known.some((k) => Math.abs(k - x) <= Math.max(0.051, Math.abs(k) * 0.005) || Math.abs(Math.round(k) - x) < 0.01);
    if (!ok) out.add(s);
  }
  return [...out];
}
