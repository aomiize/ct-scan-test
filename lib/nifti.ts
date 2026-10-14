import type { Volume } from './types';

interface Nifti {
  dims: [number, number, number];
  pix: [number, number, number];
  M: number[][];
  src: string;
  raw: ArrayLike<number>;
  slope: number;
  inter: number;
  desc: string;
}

const TYPES: Record<number, { T: { new (b: ArrayBuffer): ArrayLike<number> }; bytes: number; get: string }> = {
  2: { T: Uint8Array, bytes: 1, get: 'getUint8' },
  4: { T: Int16Array, bytes: 2, get: 'getInt16' },
  8: { T: Int32Array, bytes: 4, get: 'getInt32' },
  16: { T: Float32Array, bytes: 4, get: 'getFloat32' },
  64: { T: Float64Array, bytes: 8, get: 'getFloat64' },
  256: { T: Int8Array, bytes: 1, get: 'getInt8' },
  512: { T: Uint16Array, bytes: 2, get: 'getUint16' },
  768: { T: Uint32Array, bytes: 4, get: 'getUint32' },
};

export async function gunzipIfNeeded(buf: ArrayBuffer): Promise<ArrayBuffer> {
  const sig = new Uint8Array(buf, 0, 2);
  if (sig[0] !== 0x1f || sig[1] !== 0x8b) return buf;
  if (typeof DecompressionStream === 'undefined') {
    throw new Error('This browser cannot decompress .gz files. Use a current Chrome, Edge, Firefox or Safari, or open the uncompressed .nii.');
  }
  const stream = new Blob([buf]).stream().pipeThrough(new DecompressionStream('gzip'));
  return new Response(stream).arrayBuffer();
}

export async function readNifti(input: Blob | ArrayBuffer): Promise<Nifti> {
  const buf = input instanceof ArrayBuffer ? input : await input.arrayBuffer();
  return parseNifti(await gunzipIfNeeded(buf));
}

export function parseNifti(buf: ArrayBuffer): Nifti {
  if (buf.byteLength < 352) throw new Error('The file is too small to be a NIfTI image.');
  const dv = new DataView(buf);
  let le = true;
  const h = dv.getInt32(0, true);
  if (h !== 348) {
    if (dv.getInt32(0, false) === 348) le = false;
    else if (h === 540 || dv.getInt32(0, false) === 540)
      throw new Error('NIfTI-2 is not supported. Save as NIfTI-1 (for example with nibabel.Nifti1Image).');
    else throw new Error('This is not a NIfTI-1 file (header size is not 348).');
  }
  const i16 = (o: number) => dv.getInt16(o, le);
  const f32 = (o: number) => dv.getFloat32(o, le);

  if (i16(40) < 3) throw new Error('The image has fewer than 3 dimensions.');
  const dims: [number, number, number] = [i16(42), i16(44), i16(46)];
  const dt = i16(70);
  const pix = [1, 2, 3].map((k) => {
    const v = Math.abs(f32(76 + 4 * k));
    return v && isFinite(v) ? v : 1;
  }) as [number, number, number];
  const qfac = f32(76) < 0 ? -1 : 1;
  const voff = Math.max(348, Math.round(f32(108)) || 352);
  let slope = f32(112);
  let inter = f32(116);
  if (!slope || !isFinite(slope)) {
    slope = 1;
    inter = 0;
  }
  if (!isFinite(inter)) inter = 0;

  const qcode = i16(252);
  const scode = i16(254);
  let M: number[][];
  let src = 'none';
  if (scode > 0) {
    M = [0, 1, 2].map((r) => [0, 1, 2].map((c) => f32(280 + 16 * r + 4 * c)));
    src = 'sform';
  } else if (qcode > 0) {
    const b = f32(256), c = f32(260), d = f32(264);
    const a = Math.sqrt(Math.max(0, 1 - b * b - c * c - d * d));
    const R = [
      [a * a + b * b - c * c - d * d, 2 * (b * c - a * d), 2 * (b * d + a * c)],
      [2 * (b * c + a * d), a * a + c * c - b * b - d * d, 2 * (c * d - a * b)],
      [2 * (b * d - a * c), 2 * (c * d + a * b), a * a + d * d - c * c - b * b],
    ];
    M = R.map((r) => [r[0] * pix[0], r[1] * pix[1], r[2] * qfac * pix[2]]);
    src = 'qform';
  } else {
    M = [
      [pix[0], 0, 0],
      [0, pix[1], 0],
      [0, 0, pix[2]],
    ];
  }

  let desc = '';
  for (let i = 0; i < 80; i++) {
    const ch = dv.getUint8(148 + i);
    if (!ch) break;
    desc += String.fromCharCode(ch);
  }

  const info = TYPES[dt];
  if (!info) throw new Error(`Unsupported voxel data type (NIfTI code ${dt}).`);
  const n = dims[0] * dims[1] * dims[2];
  if (voff + n * info.bytes > buf.byteLength)
    throw new Error('The file is truncated: it holds less image data than the header declares.');

  let raw: ArrayLike<number>;
  if (le) raw = new info.T(buf.slice(voff, voff + n * info.bytes));
  else {
    const out = new Float64Array(n);
    const getter = (dv as unknown as Record<string, (o: number, le: boolean) => number>)[info.get].bind(dv);
    for (let p = 0; p < n; p++) out[p] = getter(voff + p * info.bytes, false);
    raw = out;
  }
  return { dims, pix, M, src, raw, slope, inter, desc };
}

/** For each display axis (left, posterior, superior) find the voxel axis and whether it must be flipped. */
function orientation(M: number[][]) {
  const ax = [0, 1, 2].map((a) => {
    let w = 0, best = -1;
    for (let r = 0; r < 3; r++) {
      const v = Math.abs(M[r][a]);
      if (v > best) {
        best = v;
        w = r;
      }
    }
    return { w, s: Math.sign(M[w][a]) || 1 };
  });
  if (new Set(ax.map((x) => x.w)).size < 3) {
    return [
      { a: 0, flip: true },
      { a: 1, flip: true },
      { a: 2, flip: false },
    ];
  }
  // World is RAS+. Display wants +i = left (−R), +j = posterior (−A), +k = superior (+S).
  const want = [-1, -1, 1];
  return [0, 1, 2].map((o) => {
    const a = ax.findIndex((x) => x.w === o);
    return { a, flip: ax[a].s !== want[o] };
  });
}

function reorientRaw<T extends Int16Array | Uint8Array>(nf: Nifti, out: (n: number) => T, conv: (v: number) => number) {
  const map = orientation(nf.M);
  const nd = nf.dims;
  const st = [1, nd[0], nd[0] * nd[1]];
  const od = map.map((m) => nd[m.a]);
  const sp = map.map((m) => nf.pix[m.a]);
  let base = 0;
  const step = map.map((m) => {
    if (m.flip) {
      base += (nd[m.a] - 1) * st[m.a];
      return -st[m.a];
    }
    return st[m.a];
  });
  const data = out(od[0] * od[1] * od[2]);
  const raw = nf.raw, sl = nf.slope, it = nf.inter;
  let p = 0;
  for (let k = 0; k < od[2]; k++) {
    const bk = base + k * step[2];
    for (let j = 0; j < od[1]; j++) {
      let s = bk + j * step[1];
      for (let i = 0; i < od[0]; i++, s += step[0]) data[p++] = conv(raw[s] * sl + it);
    }
  }
  return { nx: od[0], ny: od[1], nz: od[2], sx: sp[0], sy: sp[1], sz: sp[2], data };
}

export function toVolume(nf: Nifti): Volume {
  const r = reorientRaw(nf, (n) => new Int16Array(n), (v) => (v < -32768 ? -32768 : v > 32767 ? 32767 : Math.round(v)));
  return { ...r, src: nf.src, desc: nf.desc };
}

export function toMask(nf: Nifti) {
  return reorientRaw(nf, (n) => new Uint8Array(n), (v) => (v > 0.5 && v < 255.5 ? Math.round(v) : 0));
}

export function countLabels(m: Uint8Array) {
  const c = new Float64Array(256);
  for (let p = 0; p < m.length; p++) c[m[p]]++;
  return c;
}
