import type { EdgeCheck, EdgePayload } from './edge';
import type { EdgeRange } from './edge-build';
import type { AnalysisPayload, GeneratedReport, SignatureResult } from './report-types';
import type { Cursor, LabelMap, MaskState, Patient, Volume, WindowLevel } from './types';
import type { VolumeStats } from './volumetrics';

export interface RunSample {
  t: number;
  mem_used_mb?: number | null;
  mem_total_mb?: number | null;
  gpu_util?: number | null;
  cpu_util?: number | null;
  temp_c?: number | null;
  power_w?: number | null;
}
export interface RunRecord {
  id: string;
  filename: string;
  bytes: number;
  model: string;
  device: string;
  sampler: string;
  started: string;
  wall_s: number;
  status: string;
  tta?: boolean | null;
  stages: Record<string, number>;
  logs: { t: string; level: string; tag: string; msg: string }[];
  samples: RunSample[];
}

export type DraftReport = GeneratedReport & { payloadKey: string; edited: boolean };

/** Everything the tab views read. */
export interface Analysis {
  vol: Volume | null;
  ctName: string;
  sample: boolean;
  mask: MaskState | null;
  labels: LabelMap;
  scheme: string;
  stats: VolumeStats | null;
  patient: Patient;
  l3: number | null;
  cur: Cursor;
  wl: WindowLevel;
  lut: Uint8Array;
  payload: AnalysisPayload | null;
  payloadKey: string;
  /** The eight de-identified numbers that are the only data sent off the device, and their whitelist check. */
  edge: EdgePayload | null;
  edgeRange: EdgeRange | null;
  edgeCheck: EdgeCheck | null;
  report: DraftReport | null;
  signature: SignatureResult | null;
  run: RunRecord | null;
  llm: { configured: boolean; model: string | null } | null;
}
