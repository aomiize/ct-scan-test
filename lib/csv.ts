import { evaluate, roleMetrics, sliceStats } from './metrics';
import type { LabelMap, MaskState, Patient, Volume } from './types';
import { labelVolume, roleProfile, type VolumeStats } from './volumetrics';

const q = (v: unknown) => {
  const s = v == null ? '' : typeof v === 'number' ? (isFinite(v) ? String(Math.round(v * 100) / 100) : '') : String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};
const row = (...c: unknown[]) => c.map(q).join(',');

/** Metrics export: one section per table, separated by a blank line. */
export function metricsCsv(x: { caseRef: string; vol: Volume; mask: MaskState; labels: LabelMap; stats: VolumeStats; patient: Patient; l3: number | null }) {
  const { vol, mask, labels, stats } = x;
  const px = (vol.sx * vol.sy) / 100;
  const l3s = x.l3 != null ? sliceStats(vol, mask.data, x.l3) : null;
  const out: string[] = [row('case_ref', x.caseRef), ''];
  out.push(row('label', 'name', 'role', 'voxels', 'volume_cm3', 'mean_hu', 'sd_hu', 'l3_area_cm2', 'l3_mean_hu'));
  for (const [L, d] of Object.entries(labels)) {
    const v = labelVolume(vol, stats, +L);
    const n3 = l3s?.n[+L] ?? 0;
    out.push(row(L, d.name, d.role, v.voxels, v.cm3, v.meanHU, v.sdHU, l3s ? n3 * px : null, n3 ? l3s!.sum[+L] / n3 : null));
  }
  if (l3s) {
    const e = evaluate(roleMetrics(vol, labels, l3s), x.patient);
    out.push('', row('metric', 'value', 'unit', 'cutoff', 'flagged'));
    out.push(row('l3_slice', x.l3! + 1, 'index', '', ''));
    out.push(row('skeletal_muscle_area', e.sma, 'cm2', '', ''));
    out.push(row('skeletal_muscle_index', e.smi, 'cm2/m2', e.smiCut, e.lowMuscle));
    out.push(row('muscle_mean_hu', e.muscleHU, 'HU', e.huCut, e.myosteatosis));
    out.push(row('vat_area', e.vat, 'cm2', e.vatCut, e.visceralObesity));
    out.push(row('sat_area', e.sat, 'cm2', '', ''));
    out.push(row('imat_area', e.imat, 'cm2', '', ''));
    out.push(row('vat_sat_ratio', e.vatSat, '', '', ''));
  }
  const roles = ['muscle', 'sat', 'vat', 'imat'] as const;
  const prof = roles.map((r) => roleProfile(vol, labels, stats, r));
  out.push('', row('axial_slice', 'z_mm', ...roles.map((r) => `${r}_area_cm2`)));
  for (let k = 0; k < vol.nz; k++) out.push(row(k + 1, k * vol.sz, ...prof.map((p) => p[k])));
  return out.join('\n') + '\n';
}
