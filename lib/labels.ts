import type { LabelMap, Role, SchemeKey, ViewName } from './types';

export const ROLES: Record<Role, string> = {
  muscle: 'Skeletal muscle',
  sat: 'Subcutaneous fat',
  vat: 'Visceral fat',
  imat: 'Intermuscular fat',
  bone: 'Bone',
  other: 'Other',
};

export const ROLE_COLOR: Record<Role, [number, number, number]> = {
  muscle: [226, 92, 92],
  sat: [240, 198, 80],
  vat: [64, 190, 174],
  imat: [172, 128, 255],
  bone: [200, 206, 224],
  other: [236, 150, 64],
};

const EXTRA: [number, number, number][] = [
  [96, 160, 255], [255, 120, 180], [140, 220, 90], [255, 170, 90], [90, 220, 230], [220, 220, 90], [180, 140, 100],
];

export const SCHEMES: Record<SchemeKey, Record<number, [string, Role]>> = {
  generic: {
    1: ['Skeletal muscle', 'muscle'],
    2: ['Subcutaneous fat', 'sat'],
    3: ['Visceral fat', 'vat'],
    4: ['Intermuscular fat', 'imat'],
    5: ['Bone', 'bone'],
  },
  totalseg: {
    1: ['Subcutaneous fat', 'sat'],
    2: ['Torso fat', 'vat'],
    3: ['Skeletal muscle', 'muscle'],
  },
  threshold: {
    1: ['Muscle-range HU', 'muscle'],
    5: ['Bone-range HU', 'bone'],
    6: ['Fat-range HU', 'other'],
  },
};

export const SCHEME_NAMES: Record<Exclude<SchemeKey, 'threshold'>, string> = {
  generic: 'Generic: 1 muscle · 2 SAT · 3 VAT · 4 IMAT · 5 bone',
  totalseg: 'TotalSegmentator tissue_types: 1 SAT · 2 torso fat · 3 muscle',
};

export const PRESETS: [string, number, number][] = [
  ['Soft tissue', 400, 40],
  ['Abdomen', 350, 40],
  ['Liver', 150, 60],
  ['Fat', 300, -80],
  ['Bone', 1500, 300],
  ['Lung', 1500, -600],
];

export const VIEW_COLOR: Record<ViewName, string> = {
  axial: '#f0b44c',
  coronal: '#4cc3e0',
  sagittal: '#e273c8',
};

export function labelsFor(counts: Float64Array, key: SchemeKey): LabelMap {
  const sch = SCHEMES[key];
  const out: LabelMap = {};
  let e = 0;
  for (let L = 1; L < 256; L++) {
    if (!counts[L]) continue;
    const d = sch[L];
    const role: Role = d ? d[1] : 'other';
    out[L] = {
      name: d ? d[0] : `Label ${L}`,
      role,
      color: d ? ROLE_COLOR[role] : EXTRA[e++ % EXTRA.length],
      visible: role !== 'bone',
    };
  }
  return out;
}

/** Alberta-protocol HU ranges. Includes organs and the table, so it is only an estimate. */
export function thresholdMask(data: Int16Array) {
  const m = new Uint8Array(data.length);
  for (let p = 0; p < data.length; p++) {
    const v = data[p];
    if (v >= -29 && v <= 150) m[p] = 1;
    else if (v >= -190 && v <= -30) m[p] = 6;
    else if (v >= 200 && v < 2500) m[p] = 5;
  }
  return m;
}
