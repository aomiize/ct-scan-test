import 'server-only';
import path from 'node:path';

/** Base URL of the inference server, derived from INFERENCE_URL (…/segment). */
export function inferenceBase(): string | null {
  const u = process.env.INFERENCE_URL;
  if (!u) return null;
  return u.replace(/\/segment\/?$/, '');
}

export function inferenceHeaders(): Record<string, string> {
  return process.env.INFERENCE_API_KEY ? { 'X-Api-Key': process.env.INFERENCE_API_KEY } : {};
}

export const llmConfig = () => ({
  url: process.env.LLM_URL?.replace(/\/$/, '') || null,
  model: process.env.LLM_MODEL || 'medgemma-27b',
  apiKey: process.env.LLM_API_KEY || '',
  temperature: Number(process.env.LLM_TEMPERATURE ?? 0.1),
  timeoutMs: Number(process.env.LLM_TIMEOUT_MS ?? 120000),
});

export const dataDir = () => path.resolve(process.env.DATA_DIR || './data');
export const casesDir = () => (process.env.CASES_DIR ? path.resolve(process.env.CASES_DIR) : null);

/** User identity set by the hospital reverse proxy (SSO), if any. */
export function proxyUser(h: Headers): string | null {
  return h.get('x-forwarded-user') || h.get('remote-user') || h.get('x-remote-user') || null;
}

export function audit(event: string, data: Record<string, unknown>) {
  console.log(JSON.stringify({ event, at: new Date().toISOString(), ...data }));
}
