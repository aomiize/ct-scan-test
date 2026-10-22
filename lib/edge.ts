/**
 * The edge → server contract: exactly eight de-identified numbers.
 *
 * This file is shared by the browser (builds and checks the payload before it is sent) and the report route
 * (checks it again before anything reaches the language model). Because every field must be a number, the payload
 * cannot carry a name, an ID, a date or a DICOM tag, whatever a bug elsewhere might put in it.
 */

export const EDGE_FIELDS = [
  'muscle_volume_mm3',
  'muscle_density_hu',
  'sfat_volume_mm3',
  'vfat_volume_mm3',
  'mfat_volume_mm3',
  'total_fat_volume_mm3',
  'body_volume_mm3',
  'body_height_mm',
] as const;

export type EdgeField = (typeof EDGE_FIELDS)[number];
export type EdgePayload = Record<EdgeField, number | null>;

export const EDGE_FIELD_INFO: Record<EdgeField, { label: string; unit: string }> = {
  muscle_volume_mm3: { label: 'Muscle volume', unit: 'mm³' },
  muscle_density_hu: { label: 'Mean muscle density', unit: 'HU' },
  sfat_volume_mm3: { label: 'Subcutaneous fat volume', unit: 'mm³' },
  vfat_volume_mm3: { label: 'Visceral fat volume', unit: 'mm³' },
  mfat_volume_mm3: { label: 'Intramuscular fat volume', unit: 'mm³' },
  total_fat_volume_mm3: { label: 'Total fat volume', unit: 'mm³' },
  body_volume_mm3: { label: 'Body volume', unit: 'mm³' },
  body_height_mm: { label: 'Segment height (T12–L4)', unit: 'mm' },
};

/** Largest serialised size accepted. Eight numbers fit in well under 400 bytes. */
export const EDGE_MAX_BYTES = 1024;

export interface EdgeCheck {
  ok: boolean;
  errors: string[];
  bytes: number;
}

/**
 * Whitelist validation. Blocks the payload if it is not a plain object, has any key outside the eight fields,
 * misses one, holds anything but a finite number or null, or is larger than EDGE_MAX_BYTES.
 */
export function validateEdgePayload(o: unknown): EdgeCheck {
  const errors: string[] = [];
  let bytes = 0;
  try {
    bytes = new TextEncoder().encode(JSON.stringify(o)).length;
  } catch {
    return { ok: false, errors: ['payload cannot be serialised'], bytes: 0 };
  }
  if (!o || typeof o !== 'object' || Array.isArray(o) || Object.getPrototypeOf(o) !== Object.prototype) {
    return { ok: false, errors: ['payload must be a plain JSON object'], bytes };
  }
  const allowed = new Set<string>(EDGE_FIELDS);
  for (const k of Object.keys(o)) if (!allowed.has(k)) errors.push(`field "${k}" is not in the eight-field whitelist`);
  for (const k of EDGE_FIELDS) {
    if (!(k in o)) {
      errors.push(`field "${k}" is missing`);
      continue;
    }
    const v = (o as Record<string, unknown>)[k];
    if (v !== null && (typeof v !== 'number' || !Number.isFinite(v))) errors.push(`field "${k}" must be a number (got ${typeof v})`);
    else if (typeof v === 'number' && v < 0 && k !== 'muscle_density_hu') errors.push(`field "${k}" cannot be negative`);
  }
  if (!errors.length && EDGE_FIELDS.every((k) => (o as EdgePayload)[k] == null)) errors.push('all fields are empty');
  if (bytes > EDGE_MAX_BYTES) errors.push(`payload is ${bytes} bytes, limit ${EDGE_MAX_BYTES}`);
  return { ok: errors.length === 0, errors, bytes };
}

/**
 * Indices computed from the eight values at the prompt stage, so the model does not have to do arithmetic.
 * Muscle-density cut-offs are Martin et al. 2013 (L3 single slice: < 41 HU if BMI < 25, < 33 HU if BMI ≥ 25).
 * BMI is not transmitted, so density between 33 and 41 HU is reported as indeterminate.
 */
export interface DerivedIndices {
  vfat_sfat_ratio: number | null;
  total_fat_share_of_body_pct: number | null;
  sfat_share_of_body_pct: number | null;
  vfat_share_of_body_pct: number | null;
  muscle_share_of_body_pct: number | null;
  mean_muscle_cross_section_cm2: number | null;
  mean_vfat_cross_section_cm2: number | null;
  mfat_share_of_muscle_compartment_pct: number | null;
  myosteatosis: 'likely' | 'indeterminate without BMI' | 'not indicated' | 'not available';
}

const round = (v: number, d: number) => Math.round(v * 10 ** d) / 10 ** d;
const div = (a: number | null, b: number | null, scale = 1, d = 2) => (a != null && b != null && b > 0 ? round((a / b) * scale, d) : null);

export function deriveIndices(p: EdgePayload): DerivedIndices {
  const hu = p.muscle_density_hu;
  return {
    vfat_sfat_ratio: div(p.vfat_volume_mm3, p.sfat_volume_mm3),
    total_fat_share_of_body_pct: div(p.total_fat_volume_mm3, p.body_volume_mm3, 100, 1),
    sfat_share_of_body_pct: div(p.sfat_volume_mm3, p.body_volume_mm3, 100, 1),
    vfat_share_of_body_pct: div(p.vfat_volume_mm3, p.body_volume_mm3, 100, 1),
    muscle_share_of_body_pct: div(p.muscle_volume_mm3, p.body_volume_mm3, 100, 1),
    // volume / height = average area per mm of height, in mm²; /100 → cm²
    mean_muscle_cross_section_cm2: div(p.muscle_volume_mm3, p.body_height_mm, 1 / 100, 1),
    mean_vfat_cross_section_cm2: div(p.vfat_volume_mm3, p.body_height_mm, 1 / 100, 1),
    mfat_share_of_muscle_compartment_pct:
      p.mfat_volume_mm3 != null && p.muscle_volume_mm3 != null ? div(p.mfat_volume_mm3, p.mfat_volume_mm3 + p.muscle_volume_mm3, 100, 1) : null,
    myosteatosis: hu == null ? 'not available' : hu < 33 ? 'likely' : hu < 41 ? 'indeterminate without BMI' : 'not indicated',
  };
}
