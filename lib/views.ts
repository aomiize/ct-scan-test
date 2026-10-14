import type { Cursor, ViewName, Volume } from './types';

export interface ViewGeom {
  w: number;
  h: number;
  px: number;
  py: number;
  n: number;
  slice: number;
  /** Index into vol.data of image pixel (0,0), and the strides for +u and +v. */
  base: number;
  du: number;
  dv: number;
  cross: [number, number];
  lines: [ViewName, ViewName];
  orient: [string, string, string, string];
}

/** Coronal and sagittal show superior at the top, so v runs from k = nz-1 downward. */
export function geom(vol: Volume, name: ViewName, cur?: Cursor): ViewGeom {
  const { nx, ny, nz, sx, sy, sz } = vol;
  const c = cur ?? { i: 0, j: 0, k: 0 };
  switch (name) {
    case 'axial':
      return { w: nx, h: ny, px: sx, py: sy, n: nz, slice: c.k, base: nx * ny * c.k, du: 1, dv: nx,
        cross: [c.i, c.j], lines: ['sagittal', 'coronal'], orient: ['R', 'L', 'A', 'P'] };
    case 'coronal':
      return { w: nx, h: nz, px: sx, py: sz, n: ny, slice: c.j, base: nx * c.j + nx * ny * (nz - 1), du: 1, dv: -nx * ny,
        cross: [c.i, nz - 1 - c.k], lines: ['sagittal', 'axial'], orient: ['R', 'L', 'S', 'I'] };
    case 'sagittal':
      return { w: ny, h: nz, px: sy, py: sz, n: nx, slice: c.i, base: c.i + nx * ny * (nz - 1), du: nx, dv: -nx * ny,
        cross: [c.j, nz - 1 - c.k], lines: ['coronal', 'axial'], orient: ['A', 'P', 'S', 'I'] };
  }
}

/** Image pixel (u, v) in a view → voxel cursor. */
export function pick(vol: Volume, name: ViewName, cur: Cursor, u: number, v: number): Cursor {
  switch (name) {
    case 'axial':
      return { i: u, j: v, k: cur.k };
    case 'coronal':
      return { i: u, j: cur.j, k: vol.nz - 1 - v };
    case 'sagittal':
      return { i: cur.i, j: u, k: vol.nz - 1 - v };
  }
}

export function stepCursor(vol: Volume, name: ViewName, cur: Cursor, d: number): Cursor {
  const cl = (v: number, n: number) => Math.max(0, Math.min(n - 1, v));
  if (name === 'axial') return { ...cur, k: cl(cur.k + d, vol.nz) };
  if (name === 'coronal') return { ...cur, j: cl(cur.j + d, vol.ny) };
  return { ...cur, i: cl(cur.i + d, vol.nx) };
}

export function setSlice(name: ViewName, cur: Cursor, slice: number): Cursor {
  if (name === 'axial') return { ...cur, k: slice };
  if (name === 'coronal') return { ...cur, j: slice };
  return { ...cur, i: slice };
}

/** Grey-level lookup for HU in [-32768, 32767]. */
export function buildLut(w: number, l: number) {
  const lut = new Uint8Array(65536);
  const lo = l - w / 2;
  for (let i = 0; i < 65536; i++) {
    const g = ((i - 32768 - lo) / w) * 255;
    lut[i] = g < 0 ? 0 : g > 255 ? 255 : g | 0;
  }
  return lut;
}
