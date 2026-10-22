import type { EdgePayload } from './edge';
import type { LabelMap, Role, Volume } from './types';
import type { VolumeStats } from './volumetrics';

export interface EdgeRange {
  kMin: number;
  kMax: number;
  /** 'vertebrae': top of T12 to bottom of L4 from the segmentation; 'segmented': every slice that has tissue labels. */
  source: 'vertebrae' | 'segmented';
}

/** Axial slices from T12 to L4 if both vertebrae are labelled, otherwise the segmented range. */
export function edgeRange(labels: LabelMap, st: VolumeStats): EdgeRange | null {
  const find = (n: string) => Object.entries(labels).find(([, d]) => d.name === n)?.[0];
  const span = (L: string | undefined) => {
    if (!L) return null;
    let lo = -1, hi = -1;
    for (let k = 0; k < st.nz; k++) if (st.sliceN[+L * st.nz + k]) { if (lo < 0) lo = k; hi = k; }
    return lo < 0 ? null : [lo, hi];
  };
  const t12 = span(find('T12 vertebra')), l4 = span(find('L4 vertebra'));
  if (t12 && l4) return { kMin: Math.min(t12[0], l4[0]), kMax: Math.max(t12[1], l4[1]), source: 'vertebrae' };
  if (st.kMin < 0) return null;
  return { kMin: st.kMin, kMax: st.kMax, source: 'segmented' };
}

const BODY_HU = -500;

/**
 * Voxels inside the body on one axial slice: HU above -500, largest 4-connected piece (drops the table and
 * blankets), holes filled (bowel gas and lung are inside the body). Tissue-labelled voxels always count.
 */
function bodySliceCount(vol: Volume, mask: Uint8Array, k: number, inBody: Uint8Array, comp: Int32Array, stack: Int32Array): number {
  const { nx, ny, data } = vol;
  const plane = nx * ny, base = k * plane;
  comp.fill(0);
  let best = 0, bestId = 0, id = 0;
  for (let p = 0; p < plane; p++) {
    if (comp[p] || (data[base + p] <= BODY_HU && !mask[base + p])) continue;
    id++;
    let top = 0, size = 0;
    stack[top++] = p;
    comp[p] = id;
    while (top) {
      const q = stack[--top];
      size++;
      const x = q % nx, y = (q - x) / nx;
      for (let t = 0; t < 4; t++) {
        const r = t === 0 ? (x > 0 ? q - 1 : -1) : t === 1 ? (x < nx - 1 ? q + 1 : -1) : t === 2 ? (y > 0 ? q - nx : -1) : y < ny - 1 ? q + nx : -1;
        if (r < 0 || comp[r] || (data[base + r] <= BODY_HU && !mask[base + r])) continue;
        comp[r] = id;
        stack[top++] = r;
      }
    }
    if (size > best) { best = size; bestId = id; }
  }
  if (!bestId) return 0;
  // Fill holes: flood the outside from the slice border; whatever the flood cannot reach is body.
  for (let p = 0; p < plane; p++) inBody[p] = comp[p] === bestId ? 1 : 0;
  const outside = new Uint8Array(plane);
  let top = 0;
  const seed = (p: number) => { if (!inBody[p] && !outside[p]) { outside[p] = 1; stack[top++] = p; } };
  for (let x = 0; x < nx; x++) { seed(x); seed((ny - 1) * nx + x); }
  for (let y = 0; y < ny; y++) { seed(y * nx); seed(y * nx + nx - 1); }
  while (top) {
    const q = stack[--top];
    const x = q % nx, y = (q - x) / nx;
    if (x > 0) seed(q - 1);
    if (x < nx - 1) seed(q + 1);
    if (y > 0) seed(q - nx);
    if (y < ny - 1) seed(q + nx);
  }
  let n = 0;
  for (let p = 0; p < plane; p++) if (!outside[p]) n++;
  return n;
}

/** Compute the eight edge fields over the given axial range. Runs in the browser; nothing here is transmitted. */
export function buildEdgePayload(vol: Volume, mask: Uint8Array, labels: LabelMap, range: EdgeRange): EdgePayload {
  const { nx, ny, sx, sy, sz, data } = vol;
  const plane = nx * ny;
  const voxel = sx * sy * sz;
  const roleOf = new Array<Role | null>(256).fill(null);
  for (const [L, d] of Object.entries(labels)) roleOf[+L] = d.role;

  let nMuscle = 0, sumMuscle = 0, nS = 0, nV = 0, nM = 0, nBody = 0;
  const inBody = new Uint8Array(plane), comp = new Int32Array(plane), stack = new Int32Array(plane);
  for (let k = range.kMin; k <= range.kMax; k++) {
    const base = k * plane;
    for (let p = 0; p < plane; p++) {
      const L = mask[base + p];
      if (!L) continue;
      const r = roleOf[L];
      if (r === 'muscle') { nMuscle++; sumMuscle += data[base + p]; }
      else if (r === 'sat') nS++;
      else if (r === 'vat') nV++;
      else if (r === 'imat') nM++;
    }
    nBody += bodySliceCount(vol, mask, k, inBody, comp, stack);
  }
  const mm3 = (n: number) => Math.round(n * voxel);
  return {
    muscle_volume_mm3: mm3(nMuscle),
    muscle_density_hu: nMuscle ? Math.round((sumMuscle / nMuscle) * 10) / 10 : null,
    sfat_volume_mm3: mm3(nS),
    vfat_volume_mm3: mm3(nV),
    mfat_volume_mm3: mm3(nM),
    total_fat_volume_mm3: mm3(nS + nV + nM),
    body_volume_mm3: mm3(nBody),
    body_height_mm: Math.round((range.kMax - range.kMin + 1) * sz * 10) / 10,
  };
}
