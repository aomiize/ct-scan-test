export type ViewName = 'axial' | 'coronal' | 'sagittal';
export type Role = 'muscle' | 'sat' | 'vat' | 'imat' | 'bone' | 'other';
export type SchemeKey = 'generic' | 'totalseg' | 'threshold';
export type Tool = 'cross' | 'wl' | 'pan' | 'cal';

/** CT volume reoriented so i → patient left, j → posterior, k → superior. */
export interface Volume {
  nx: number;
  ny: number;
  nz: number;
  sx: number;
  sy: number;
  sz: number;
  data: Int16Array;
  src: string;
  desc: string;
}

export interface MaskState {
  data: Uint8Array;
  name: string;
  source: 'file' | 'sample' | 'threshold' | 'inference';
  counts: Float64Array;
}

export interface LabelInfo {
  name: string;
  role: Role;
  color: [number, number, number];
  visible: boolean;
}
export type LabelMap = Record<number, LabelInfo>;

export interface Cursor {
  i: number;
  j: number;
  k: number;
}

export interface WindowLevel {
  w: number;
  l: number;
}

export interface Measurement {
  id: number;
  view: ViewName;
  slice: number;
  a: [number, number];
  b: [number, number];
}

export interface Patient {
  sex: '' | 'M' | 'F';
  age: string;
  heightCm: string;
  weightKg: string;
}
