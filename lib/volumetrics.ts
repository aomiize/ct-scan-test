import { ROLES } from './labels';
import type { LabelMap, Role, Volume } from './types';

/** One pass over the whole volume: per-label voxel count, HU sum and sum of squares, and per-slice counts. */
export interface VolumeStats {
  nz: number;
  n: Float64Array;
  sum: Float64Array;
  sumsq: Float64Array;
  /** sliceN[L * nz + k] = voxels of label L on axial slice k */
  sliceN: Uint32Array;
  /** first and last axial slice that holds any label */
  kMin: number;
  kMax: number;
}

export function volumeStats(vol: Volume, mask: Uint8Array): VolumeStats {
  const { nx, ny, nz, data } = vol;
  const n = new Float64Array(256), sum = new Float64Array(256), sumsq = new Float64Array(256);
  const sliceN = new Uint32Array(256 * nz);
  const plane = nx * ny;
  let kMin = -1, kMax = -1;
  for (let k = 0; k < nz; k++) {
    const base = k * plane;
    let any = false;
    for (let p = 0; p < plane; p++) {
      const L = mask[base + p];
      if (!L) continue;
      any = true;
      const v = data[base + p];
      n[L]++;
      sum[L] += v;
      sumsq[L] += v * v;
      sliceN[L * nz + k]++;
    }
    if (any) {
      if (kMin < 0) kMin = k;
      kMax = k;
    }
  }
  return { nz, n, sum, sumsq, sliceN, kMin, kMax };
}

export interface TissueVolume {
  voxels: number;
  cm3: number;
  meanHU: number | null;
  sdHU: number | null;
}

export function labelVolume(vol: Volume, st: VolumeStats, L: number): TissueVolume {
  const n = st.n[L];
  const mean = n ? st.sum[L] / n : null;
  const sd = n > 1 && mean != null ? Math.sqrt(Math.max(0, st.sumsq[L] / n - mean * mean)) : null;
  return { voxels: n, cm3: (n * vol.sx * vol.sy * vol.sz) / 1000, meanHU: mean, sdHU: sd };
}

export function roleVolumes(vol: Volume, labels: LabelMap, st: VolumeStats): Record<Role, TissueVolume> {
  const acc = Object.fromEntries(Object.keys(ROLES).map((r) => [r, { n: 0, s: 0, q: 0 }])) as Record<Role, { n: number; s: number; q: number }>;
  for (const [L, d] of Object.entries(labels)) {
    acc[d.role].n += st.n[+L];
    acc[d.role].s += st.sum[+L];
    acc[d.role].q += st.sumsq[+L];
  }
  const out = {} as Record<Role, TissueVolume>;
  for (const r of Object.keys(acc) as Role[]) {
    const { n, s, q } = acc[r];
    const mean = n ? s / n : null;
    out[r] = {
      voxels: n,
      cm3: (n * vol.sx * vol.sy * vol.sz) / 1000,
      meanHU: mean,
      sdHU: n > 1 && mean != null ? Math.sqrt(Math.max(0, q / n - mean * mean)) : null,
    };
  }
  return out;
}

/** Cross-sectional area (cm²) per axial slice for one tissue role. */
export function roleProfile(vol: Volume, labels: LabelMap, st: VolumeStats, role: Role): Float32Array {
  const out = new Float32Array(st.nz);
  const px = (vol.sx * vol.sy) / 100;
  for (const [L, d] of Object.entries(labels)) {
    if (d.role !== role) continue;
    const off = +L * st.nz;
    for (let k = 0; k < st.nz; k++) out[k] += st.sliceN[off + k] * px;
  }
  return out;
}
