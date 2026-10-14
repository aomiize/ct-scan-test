/**
 * Reference cut-offs used for flags. Edit this file to match your hospital's validated thresholds.
 * Only published values are included; a metric without a reference shows "no reference set".
 */
import type { Patient } from './types';

export interface Cutoff {
  value: number;
  /** 'below' = flag when the measurement is lower than value. */
  flagWhen: 'below' | 'above';
  label: string;
  source: string;
}

const MARTIN = 'Martin L, et al. J Clin Oncol 2013;31:1539–47';
const DOYLE = 'Doyle SL, et al. Nutr Res 2013;33:171–9 (measured at L3–L4)';

export function bmiOf(p: Patient): number | null {
  const h = +p.heightCm, w = +p.weightKg;
  return h > 0 && w > 0 ? w / (h / 100) ** 2 : null;
}

export const REFERENCE = {
  /** Skeletal muscle index at L3, cm²/m². */
  smi(p: Patient): Cutoff | null {
    const b = bmiOf(p);
    if (!p.sex || b == null) return null;
    return { value: p.sex === 'F' ? 41 : b < 25 ? 43 : 53, flagWhen: 'below', label: 'Low muscle mass', source: MARTIN };
  },
  /** Mean skeletal muscle attenuation at L3, HU. */
  smra(p: Patient): Cutoff | null {
    const b = bmiOf(p);
    if (b == null) return null;
    return { value: b < 25 ? 41 : 33, flagWhen: 'below', label: 'Low muscle attenuation (myosteatosis)', source: MARTIN };
  },
  /** Visceral fat area at L3, cm². */
  vatArea(p: Patient): Cutoff | null {
    if (!p.sex) return null;
    return { value: p.sex === 'M' ? 163.8 : 80.1, flagWhen: 'above', label: 'Visceral obesity', source: DOYLE };
  },
  /** VAT/SAT area ratio. No widely accepted cut-off, so none is set. */
  vatSatRatio(_p: Patient): Cutoff | null {
    return null;
  },
};

export function isFlagged(value: number | null, c: Cutoff | null): boolean | null {
  if (value == null || !c || !isFinite(value)) return null;
  return c.flagWhen === 'below' ? value < c.value : value > c.value;
}
