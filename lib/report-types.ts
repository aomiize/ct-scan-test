/** De-identified metrics: the only data sent to the language model. */
export interface AnalysisPayload {
  schema: 'bodycomp.metrics/v1';
  case_ref: string;
  synthetic_sample: boolean;
  scan: {
    axial_slices: number;
    spacing_mm: [number, number, number];
    segmented_slices: [number, number] | null;
    segmented_extent_mm: number | null;
  };
  segmentation: { source: string; scheme: string };
  patient: { sex: 'M' | 'F' | null; age_years: number | null; height_cm: number | null; weight_kg: number | null; bmi: number | null };
  l3: {
    slice_index: number;
    skeletal_muscle_area_cm2: number | null;
    skeletal_muscle_index_cm2_m2: number | null;
    muscle_mean_hu: number | null;
    vat_area_cm2: number | null;
    sat_area_cm2: number | null;
    imat_area_cm2: number | null;
    vat_sat_ratio: number | null;
  } | null;
  volumes_segmented_range: {
    muscle_cm3: number | null;
    muscle_mean_hu: number | null;
    sat_cm3: number | null;
    vat_cm3: number | null;
    imat_cm3: number | null;
    adipose_total_cm3: number | null;
    adipose_share_pct: number | null;
  } | null;
  references: { metric: string; cutoff: number; flag_when: 'below' | 'above'; flagged: boolean | null; source: string }[];
  quality_flags: string[];
}

export interface Narrative {
  summary: string;
  examination: string;
  muscle: string;
  adipose: string;
  recommendations: string[];
  limitations: string;
}

export interface GeneratedReport {
  source: 'llm' | 'rules';
  generatedAt: string;
  narrative: Narrative;
  /** Numbers in the narrative that do not match any value in the payload. */
  unverifiedNumbers: string[];
  model?: string;
  temperature?: number;
  latencyMs?: number;
  promptSha256?: string;
  /** Model calls made (2 = one retry after an unreadable reply). */
  attempts?: number;
  /** Set when the model failed and this is the rule-based draft instead. */
  fallbackReason?: string;
  request?: unknown;
  rawResponse?: string;
}

export interface SignatureResult {
  sha256: string;
  signature: string;
  algorithm: 'Ed25519';
  keyFingerprint: string;
  signedAt: string;
  reader: string;
  authenticatedUser: string | null;
  file: string;
}
