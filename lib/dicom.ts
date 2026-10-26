/**
 * DICOM → NIfTI in the browser. No server and no upload: the DICOM headers (with the patient's name, ID and dates)
 * never leave this computer; only pixel data and geometry go into the NIfTI.
 *
 * Supports uncompressed transfer syntaxes (implicit/explicit VR little endian, explicit big endian), which is what
 * CT scanners and PACS exports normally use. Compressed studies (JPEG, JPEG 2000, RLE) are reported so the caller
 * can fall back to the inference server's converter.
 */
import dicomParser from 'dicom-parser';

export interface DicomFile {
  name: string;
  bytes: Uint8Array;
}

export interface SeriesInfo {
  id: string;
  uid: string;
  modality: string;
  description: string;
  slices: number;
}

export interface DicomResult {
  /** gzipped NIfTI-1 (int16 HU, sform in RAS) */
  nifti: Uint8Array;
  chosen: SeriesInfo;
  series: SeriesInfo[];
  rows: number;
  cols: number;
  spacing: [number, number, number];
  skipped: number;
  warnings: string[];
}

export class CompressedDicomError extends Error {}

const UNCOMPRESSED = new Set(['1.2.840.10008.1.2', '1.2.840.10008.1.2.1', '1.2.840.10008.1.2.2']);
const BIG_ENDIAN = '1.2.840.10008.1.2.2';

interface Slice {
  series: string;
  key: string;
  modality: string;
  description: string;
  pos: number[];
  rowCos: number[];
  colCos: number[];
  ps: [number, number];
  rows: number;
  cols: number;
  bits: number;
  signed: boolean;
  slope: number;
  inter: number;
  big: boolean;
  bytes: Uint8Array;
  offset: number;
  length: number;
  instance: number;
}

const nums = (s: string | undefined) => (s ? s.split('\\').map(Number) : []);

function parse(f: DicomFile): Slice | 'compressed' | null {
  let ds: dicomParser.DataSet;
  try {
    ds = dicomParser.parseDicom(f.bytes);
  } catch {
    try {
      // files without the 128-byte preamble and "DICM" marker
      ds = dicomParser.parseDicom(f.bytes, { TransferSyntaxUID: '1.2.840.10008.1.2' } as never);
    } catch {
      return null;
    }
  }
  const px = ds.elements.x7fe00010;
  const pos = nums(ds.string('x00200032'));
  const ori = nums(ds.string('x00200037'));
  if (!px || pos.length !== 3 || ori.length !== 6) return null;
  const imageType = (ds.string('x00080008') || '').toUpperCase();
  if (imageType.includes('LOCALIZER')) return null;
  const ts = ds.string('x00020010') || '1.2.840.10008.1.2';
  if (!UNCOMPRESSED.has(ts) || px.encapsulatedPixelData) return 'compressed';
  const rows = ds.uint16('x00280010') ?? 0, cols = ds.uint16('x00280011') ?? 0;
  const ps = nums(ds.string('x00280030'));
  const bits = ds.uint16('x00280100') ?? 16;
  if ((ds.uint16('x00280002') ?? 1) !== 1 || !rows || !cols || (bits !== 16 && bits !== 8)) return null;
  const series = ds.string('x0020000e') || 'unknown';
  return {
    series,
    key: `${series}|${rows}x${cols}|${ori.map((v) => v.toFixed(3)).join(',')}`,
    modality: ds.string('x00080060') || '',
    description: ds.string('x0008103e') || '',
    pos,
    rowCos: ori.slice(0, 3),
    colCos: ori.slice(3, 6),
    ps: [ps[0] || 1, ps[1] || ps[0] || 1],
    rows,
    cols,
    bits,
    signed: (ds.uint16('x00280103') ?? 0) === 1,
    slope: Number(ds.string('x00281053') ?? 1) || 1,
    inter: Number(ds.string('x00281052') ?? 0) || 0,
    big: ts === BIG_ENDIAN,
    bytes: f.bytes,
    offset: px.dataOffset,
    length: px.length,
    instance: Number(ds.string('x00200013') ?? 0),
  };
}

const dot = (a: number[], b: number[]) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a: number[], b: number[]) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];

/** Convert the largest image series (CT preferred) among the files to a gzipped NIfTI. */
export async function dicomToNifti(files: DicomFile[], onProgress?: (msg: string) => void): Promise<DicomResult> {
  const groups = new Map<string, Slice[]>();
  let skipped = 0, compressed = 0;
  files.forEach((f, n) => {
    if (n % 50 === 0) onProgress?.(`Reading DICOM headers ${n}/${files.length}…`);
    const s = parse(f);
    if (s === 'compressed') compressed++;
    else if (!s) skipped++;
    else (groups.get(s.key) ?? groups.set(s.key, []).get(s.key)!).push(s);
  });
  if (!groups.size) {
    if (compressed) throw new CompressedDicomError(`${compressed} DICOM files use a compressed transfer syntax (JPEG/JPEG 2000/RLE), which the browser converter does not decode.`);
    throw new Error('No DICOM images with position and orientation found.');
  }

  const series: SeriesInfo[] = [...groups.entries()].map(([id, ss]) => ({ id, uid: ss[0].series, modality: ss[0].modality, description: ss[0].description, slices: ss.length }));
  // Largest CT series; any modality if there is no CT.
  const pick = [...groups.entries()].sort((a, b) => Number(b[1][0].modality === 'CT') - Number(a[1][0].modality === 'CT') || b[1].length - a[1].length)[0];
  let slices = pick[1];
  if (slices.length < 2) throw new Error('The largest series has a single image; a CT volume needs at least two slices.');

  const warnings: string[] = [];
  const s0 = slices[0];
  const normal = cross(s0.rowCos, s0.colCos);
  slices.sort((a, b) => dot(a.pos, normal) - dot(b.pos, normal) || a.instance - b.instance);
  // Drop exact duplicates (same position), which some exports contain.
  const unique = slices.filter((s, i) => i === 0 || Math.abs(dot(s.pos, normal) - dot(slices[i - 1].pos, normal)) > 1e-3);
  if (unique.length < slices.length) warnings.push(`${slices.length - unique.length} duplicate slices dropped`);
  slices = unique;

  const n = slices.length, { rows, cols } = s0;
  const gaps = slices.slice(1).map((s, i) => dot(s.pos, normal) - dot(slices[i].pos, normal));
  const sortedGaps = [...gaps].sort((a, b) => a - b);
  const dz = sortedGaps[Math.floor(sortedGaps.length / 2)];
  if (gaps.some((g) => Math.abs(g - dz) > 0.1 * dz + 0.01)) warnings.push('slice spacing is not uniform; volumes may be slightly off');

  onProgress?.(`Building a ${cols}×${rows}×${n} volume…`);
  const plane = rows * cols;
  const data = new Int16Array(plane * n);
  slices.forEach((s, k) => {
    const dv = new DataView(s.bytes.buffer, s.bytes.byteOffset + s.offset, Math.min(s.length, plane * (s.bits / 8)));
    const le = !s.big;
    const base = k * plane;
    for (let p = 0; p < plane; p++) {
      const raw = s.bits === 8 ? (s.signed ? dv.getInt8(p) : dv.getUint8(p)) : s.signed ? dv.getInt16(p * 2, le) : dv.getUint16(p * 2, le);
      const hu = Math.round(raw * s.slope + s.inter);
      data[base + p] = hu < -32768 ? -32768 : hu > 32767 ? 32767 : hu;
    }
  });

  // Voxel (i = column, j = row, k = slice) → patient LPS → NIfTI RAS (negate x and y).
  const [rs, cs] = s0.ps; // PixelSpacing = row spacing (along columns), column spacing (along rows)
  const step = [0, 1, 2].map((a) => (slices[n - 1].pos[a] - slices[0].pos[a]) / (n - 1));
  const P = slices[0].pos;
  const lps = [0, 1, 2].map((a) => [s0.rowCos[a] * cs, s0.colCos[a] * rs, step[a], P[a]]);
  const srow = [lps[0].map((v) => -v), lps[1].map((v) => -v), lps[2]];

  const nifti = await gzip(writeNifti(data, [cols, rows, n], [cs, rs, Math.abs(dz)], srow));
  const chosen = series.find((x) => x.id === pick[0])!;
  return { nifti, chosen, series, rows, cols, spacing: [cs, rs, Math.abs(dz)], skipped, warnings };
}

function writeNifti(data: Int16Array, dims: number[], pix: number[], srow: number[][]): Uint8Array {
  const out = new Uint8Array(352 + data.byteLength);
  const dv = new DataView(out.buffer);
  dv.setInt32(0, 348, true);
  [3, dims[0], dims[1], dims[2], 1, 1, 1, 1].forEach((v, i) => dv.setInt16(40 + 2 * i, v, true));
  dv.setInt16(70, 4, true); // DT_INT16
  dv.setInt16(72, 16, true);
  [1, pix[0], pix[1], pix[2], 0, 0, 0, 0].forEach((v, i) => dv.setFloat32(76 + 4 * i, v, true));
  dv.setFloat32(108, 352, true);
  dv.setFloat32(112, 1, true);
  dv.setFloat32(116, 0, true);
  dv.setUint8(123, 2); // mm
  const desc = 'BodyComp browser DICOM conversion';
  for (let i = 0; i < desc.length; i++) dv.setUint8(148 + i, desc.charCodeAt(i));
  dv.setInt16(252, 0, true); // qform_code
  dv.setInt16(254, 1, true); // sform_code: scanner
  srow.forEach((r, ri) => r.forEach((v, ci) => dv.setFloat32(280 + 16 * ri + 4 * ci, v, true)));
  [0x6e, 0x2b, 0x31, 0].forEach((c, i) => dv.setUint8(344 + i, c)); // "n+1\0"
  out.set(new Uint8Array(data.buffer, data.byteOffset, data.byteLength), 352);
  return out;
}

async function gzip(buf: Uint8Array): Promise<Uint8Array> {
  const { gzip: gz } = await import('fflate');
  return new Promise((res, rej) => gz(buf, { level: 1 }, (e, d) => (e ? rej(e) : res(d))));
}
