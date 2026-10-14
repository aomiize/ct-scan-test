import { ROLES } from './labels';
import type { LabelMap, MaskState, Measurement, Patient, Role, Volume } from './types';
import { geom } from './views';
import { bmiOf, isFlagged, REFERENCE } from './reference';

export interface SliceStats {
  n: Float64Array;
  sum: Float64Array;
}

export function sliceStats(vol: Volume, mask: Uint8Array, k: number): SliceStats {
  const { nx, ny } = vol;
  const base = nx * ny * k;
  const n = new Float64Array(256);
  const sum = new Float64Array(256);
  const d = vol.data;
  for (let p = 0; p < nx * ny; p++) {
    const L = mask[base + p];
    if (L) {
      n[L]++;
      sum[L] += d[base + p];
    }
  }
  return { n, sum };
}

export type RoleMetrics = Record<Role, { area: number; hu: number | null }>;

export function roleMetrics(vol: Volume, labels: LabelMap, st: SliceStats): RoleMetrics {
  const pxCm2 = (vol.sx * vol.sy) / 100;
  const acc = Object.fromEntries(Object.keys(ROLES).map((r) => [r, { n: 0, sum: 0 }])) as Record<Role, { n: number; sum: number }>;
  for (const [L, d] of Object.entries(labels)) {
    acc[d.role].n += st.n[+L];
    acc[d.role].sum += st.sum[+L];
  }
  const out = {} as RoleMetrics;
  for (const r of Object.keys(acc) as Role[]) {
    out[r] = { area: acc[r].n * pxCm2, hu: acc[r].n ? acc[r].sum / acc[r].n : null };
  }
  return out;
}

export function bmi(p: Patient): number | null {
  return bmiOf(p);
}

export interface Evaluation {
  sma: number;
  smi: number | null;
  muscleHU: number | null;
  vat: number;
  sat: number;
  imat: number;
  vatSat: number | null;
  smiCut: number | null;
  lowMuscle: boolean | null;
  huCut: number | null;
  myosteatosis: boolean | null;
  vatCut: number | null;
  visceralObesity: boolean | null;
}

/** Cut-offs come from lib/reference.ts. */
export function evaluate(rm: RoleMetrics, p: Patient): Evaluation {
  const h = +p.heightCm / 100;
  const smi = h > 0 && rm.muscle.area > 0 ? rm.muscle.area / (h * h) : null;
  const cSmi = REFERENCE.smi(p), cHu = REFERENCE.smra(p), cVat = REFERENCE.vatArea(p);
  return {
    sma: rm.muscle.area,
    smi,
    muscleHU: rm.muscle.hu,
    vat: rm.vat.area,
    sat: rm.sat.area,
    imat: rm.imat.area,
    vatSat: rm.sat.area > 0 ? rm.vat.area / rm.sat.area : null,
    smiCut: smi != null ? cSmi?.value ?? null : null,
    lowMuscle: isFlagged(smi, cSmi),
    huCut: rm.muscle.hu != null ? cHu?.value ?? null : null,
    myosteatosis: isFlagged(rm.muscle.hu, cHu),
    vatCut: cVat?.value ?? null,
    visceralObesity: rm.vat.area > 0 ? isFlagged(rm.vat.area, cVat) : null,
  };
}

export function measLength(vol: Volume, m: Measurement) {
  const g = geom(vol, m.view);
  return Math.hypot((m.b[0] - m.a[0]) * g.px, (m.b[1] - m.a[1]) * g.py);
}

const r1 = (v: number | null) => (v == null || !isFinite(v) ? null : Math.round(v * 10) / 10);
const r2 = (v: number | null) => (v == null || !isFinite(v) ? null : Math.round(v * 100) / 100);

export interface ReportInput {
  vol: Volume;
  ctName: string;
  sample: boolean;
  mask: MaskState | null;
  labels: LabelMap;
  scheme: string;
  patient: Patient;
  l3: number | null;
  meas: Measurement[];
}

export function buildReport(x: ReportInput) {
  const { vol: v, mask } = x;
  const b = bmi(x.patient);
  const flags: string[] = [];
  let l3 = null;
  if (mask && x.l3 != null) {
    const r = evaluate(roleMetrics(v, x.labels, sliceStats(v, mask.data, x.l3)), x.patient);
    l3 = {
      slice_index: x.l3,
      z_mm: r1(x.l3 * v.sz),
      skeletal_muscle_area_cm2: r1(r.sma),
      skeletal_muscle_index_cm2_m2: r1(r.smi),
      muscle_mean_hu: r1(r.muscleHU),
      vat_area_cm2: r1(r.vat),
      sat_area_cm2: r1(r.sat),
      imat_area_cm2: r1(r.imat),
      vat_sat_ratio: r2(r.vatSat),
      reference: 'SMI/SMRA: Martin et al., J Clin Oncol 2013; VAT area: Doyle et al., Nutr Res 2013',
      smi_cutoff: r.smiCut,
      low_muscle: r.lowMuscle,
      hu_cutoff: r.huCut,
      myosteatosis: r.myosteatosis,
      vat_cutoff_cm2: r.vatCut,
      visceral_obesity: r.visceralObesity,
    };
    if (r.lowMuscle) flags.push('L3 SMI below reference cut-off');
    if (r.myosteatosis) flags.push('Muscle attenuation below reference cut-off');
    if (r.visceralObesity) flags.push('L3 visceral fat area above reference cut-off');
  }
  if (mask?.source === 'threshold') flags.push('Threshold map: includes organs and table; not valid for SMI without manual correction');
  if (x.sample) flags.push('Synthetic phantom, not patient data');
  if (mask && x.l3 == null) flags.push('L3 slice not set');

  return {
    generated_at: new Date().toISOString(),
    case_id: x.ctName.replace(/\.nii(\.gz)?$/i, ''),
    ct_file: x.ctName,
    synthetic_sample: x.sample,
    geometry: {
      dims: [v.nx, v.ny, v.nz],
      spacing_mm: [v.sx, v.sy, v.sz].map((s) => +s.toFixed(4)),
      orientation_source: v.src,
      display_axes: 'i→left, j→posterior, k→superior',
    },
    segmentation: mask
      ? {
          file: mask.name,
          source: mask.source,
          scheme: mask.source === 'threshold' ? 'threshold' : x.scheme,
          labels: Object.fromEntries(
            Object.entries(x.labels).map(([L, d]) => [
              L,
              { name: d.name, role: d.role, volume_cm3: r1((mask.counts[+L] * v.sx * v.sy * v.sz) / 1000) },
            ]),
          ),
        }
      : null,
    patient: {
      sex: x.patient.sex || null,
      height_cm: +x.patient.heightCm || null,
      weight_kg: +x.patient.weightKg || null,
      bmi: r1(b),
    },
    l3,
    flags,
    measurements: x.meas.map((m) => ({ view: m.view, slice_index: m.slice, length_mm: r1(measLength(v, m)) })),
    disclaimer:
      'Research and decision-support use. Not a cleared medical device. A qualified reader must verify segmentation and landmark before clinical use.',
  };
}
export type Report = ReturnType<typeof buildReport>;

export function reportText(r: Report): string {
  if (!r.l3) return '';
  const l = r.l3, p = r.patient;
  const d = (v: unknown) => (v == null ? '–' : String(v));
  return `CT BODY COMPOSITION — ${r.case_id}
Level: L3 (axial slice ${l.slice_index + 1}, z ${d(l.z_mm)} mm)
Patient: ${p.sex || 'sex n/a'}, ${d(p.height_cm)} cm, ${d(p.weight_kg)} kg, BMI ${d(p.bmi)}

Skeletal muscle area   ${d(l.skeletal_muscle_area_cm2)} cm²
Skeletal muscle index  ${d(l.skeletal_muscle_index_cm2_m2)} cm²/m²${l.smi_cutoff ? ` (cut-off <${l.smi_cutoff}: ${l.low_muscle ? 'LOW' : 'normal'})` : ''}
Muscle attenuation     ${d(l.muscle_mean_hu)} HU${l.hu_cutoff ? ` (cut-off <${l.hu_cutoff}: ${l.myosteatosis ? 'LOW' : 'normal'})` : ''}
Visceral fat area      ${d(l.vat_area_cm2)} cm²${l.vat_cutoff_cm2 ? ` (cut-off >${l.vat_cutoff_cm2}: ${l.visceral_obesity ? 'HIGH' : 'normal'})` : ''}
Subcutaneous fat area  ${d(l.sat_area_cm2)} cm²
Intermuscular fat area ${d(l.imat_area_cm2)} cm²
VAT/SAT ratio          ${d(l.vat_sat_ratio)}
${r.flags.length ? '\nNotes: ' + r.flags.join('; ') + '\n' : ''}
Reference: ${l.reference}. ${r.disclaimer}`;
}
