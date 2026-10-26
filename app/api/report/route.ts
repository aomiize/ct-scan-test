import { protect } from '@/lib/auth';
import { createHash } from 'node:crypto';
import { NextRequest } from 'next/server';
import { asyncable } from '@/lib/server/jobs';
import { deriveIndices, EDGE_FIELD_INFO, EDGE_FIELDS, type EdgePayload, validateEdgePayload } from '@/lib/edge';
import { unverifiedNumbers } from '@/lib/payload';
import type { GeneratedReport, Narrative } from '@/lib/report-types';
import { audit, llmConfig, proxyUser } from '@/lib/server/config';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 180;

const SYSTEM = `You draft CT body-composition reports for a physician, who will review and sign them.
The data are eight de-identified volumetric measurements of the abdominal segment from vertebra T12 to L4,
produced by automated segmentation on an edge device, plus indices derived from them. Nothing else is known
about the patient: no sex, age, height, weight or history.
Rules:
- Use only the numbers you are given. Never invent, estimate, convert or calculate values; every percentage and ratio
  you need is already in "Derived indices". Quote each one under its exact name (for example, sfat_share_of_body_pct
  is the subcutaneous fat share; total_fat_share_of_body_pct is all fat together).
- Write volumes in cm³, using the values under "Volumes in cm³". Do not write mm³ or "million".
- If a value is null, say it is not available.
- There are no reference ranges for these volumes. Do not call a volume or a share low, normal or high; describe the
  values and the fat distribution instead.
- Muscle density: use the "myosteatosis" field as given. Its cut-offs (33 and 41 HU, Martin 2013) come from a single
  L3 slice, so describe it as an indication, not a diagnosis.
- Sex- and height-specific cut-offs (such as skeletal muscle index) cannot be applied; say so instead of guessing.
- A higher visceral/subcutaneous fat ratio means a more central (visceral) fat distribution; do not quote a cut-off for it.
- Be concise and clinical. Do not mention or make up any patient identifier.
Write:
- "summary": two or three sentences with the overall picture.
- "examination": what was measured (segment, method).
- "muscle": muscle quantity and quality, and what it suggests for sarcopenia risk.
- "adipose": fat distribution, and what it suggests for metabolic syndrome risk.
- "recommendations": short lifestyle guidance and suggested follow-up, as a list.
- "limitations": what these data cannot show.
Reply with one JSON object and nothing else:
{"summary": string, "examination": string, "muscle": string, "adipose": string, "recommendations": string[], "limitations": string}`;

/** The user message: the eight values with labels and units, the derived indices, and readable cm³ versions. */
function userMessage(p: EdgePayload) {
  const cm3 = (v: number | null) => (v == null ? null : Math.round(v / 100) / 10);
  const readable = Object.fromEntries(
    EDGE_FIELDS.filter((k) => k.endsWith('_mm3')).map((k) => [k.replace('_mm3', '_cm3'), cm3(p[k])]),
  );
  const lines = EDGE_FIELDS.map((k) => `- ${EDGE_FIELD_INFO[k].label}: ${p[k] ?? 'null'} ${EDGE_FIELD_INFO[k].unit}`);
  return [
    'Measurements (T12–L4 segment), as transmitted:',
    ...lines,
    '',
    'Same values as JSON:',
    JSON.stringify(p),
    '',
    'Volumes in cm³ (use these in the report):',
    JSON.stringify(readable),
    '',
    'Derived indices:',
    JSON.stringify(deriveIndices(p), null, 2),
  ].join('\n');
}

const RETRY_NOTE = 'Your previous reply was not a valid JSON object. Reply again with only the JSON object described in the instructions: no markdown, no code fences, no other text.';

type Msg = { role: 'system' | 'user' | 'assistant'; content: string };

async function getHandler() {
  const c = llmConfig();
  return Response.json({ configured: !!c.url, model: c.url ? c.model : null });
}

async function handle(req: NextRequest): Promise<Response> {
  const c = llmConfig();
  if (!c.url) return new Response('No language model configured. Set LLM_URL in .env.local.', { status: 501 });

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return new Response('Request body must be JSON.', { status: 400 });
  }
  // Second whitelist check (the browser checks first). Anything but the eight numeric fields is refused here,
  // before a single byte reaches the language model.
  const check = validateEdgePayload(body);
  if (!check.ok) {
    audit('report.blocked', { user: proxyUser(req.headers), errors: check.errors });
    return new Response(`Payload blocked by the whitelist check: ${check.errors.join('; ')}.`, { status: 422 });
  }
  const payload = body as EdgePayload;
  const payloadSha256 = createHash('sha256').update(JSON.stringify(payload)).digest('hex');

  const messages: Msg[] = [
    { role: 'system', content: SYSTEM },
    { role: 'user', content: userMessage(payload) },
  ];
  const promptSha256 = createHash('sha256').update(JSON.stringify(messages)).digest('hex');
  const started = Date.now();
  audit('report.request', { user: proxyUser(req.headers), payload_sha256: payloadSha256, bytes: check.bytes, model: c.model, prompt_sha256: promptSha256 });

  // Ask for JSON mode first (vLLM, Ollama and others support it); drop it if this server rejects the option.
  let jsonMode = true;
  const call = async (msgs: Msg[]) => {
    const body: Record<string, unknown> = { model: c.model, messages: msgs, temperature: c.temperature, max_tokens: Number(process.env.LLM_MAX_TOKENS ?? 3000) };
    if (jsonMode) body.response_format = { type: 'json_object' };
    let r = await post(c, body);
    if (jsonMode && (r.status === 400 || r.status === 422)) {
      jsonMode = false;
      delete body.response_format;
      r = await post(c, body);
    }
    if (!r.ok) throw new HttpError(`Language model returned HTTP ${r.status}. ${(await r.text()).slice(0, 400)}`);
    const j = (await r.json()) as { choices?: { message?: { content?: string } }[] };
    return { raw: j.choices?.[0]?.message?.content ?? '', body };
  };

  let raw = '';
  let sentBody: Record<string, unknown> = {};
  let narrative: Narrative | null = null;
  let attempts = 0;
  try {
    // First try, then one retry that shows the model its unreadable reply.
    for (const msgs of [messages, null]) {
      attempts++;
      const convo = msgs ?? [...messages, { role: 'assistant' as const, content: raw.slice(0, 4000) }, { role: 'user' as const, content: RETRY_NOTE }];
      const out = await call(convo);
      raw = out.raw;
      sentBody = out.body;
      narrative = parseNarrative(raw);
      if (narrative) break;
      audit('report.unparsable', { payload_sha256: payloadSha256, attempt: attempts, start: raw.slice(0, 120) });
    }
  } catch (e) {
    const err = e as Error;
    audit('report.error', { payload_sha256: payloadSha256, error: err.message });
    if (err instanceof HttpError) return new Response(err.message, { status: 502 });
    return new Response(err.name === 'TimeoutError' ? 'The language model did not answer in time.' : `Cannot reach the language model (${err.message}).`, { status: 504 });
  }

  if (!narrative) {
    return new Response(`The model reply was not the expected JSON after ${attempts} attempts. Reply started: ${raw.slice(0, 200)}`, { status: 502 });
  }

  const text = [narrative.summary, narrative.examination, narrative.muscle, narrative.adipose, ...narrative.recommendations, narrative.limitations].join('\n');
  const result: GeneratedReport = {
    source: 'llm',
    generatedAt: new Date().toISOString(),
    narrative,
    unverifiedNumbers: unverifiedNumbers(text, payload, deriveIndices(payload), [33, 41, 2013],
      EDGE_FIELDS.map((k) => (payload[k] == null ? null : payload[k]! / 1000))),
    model: c.model,
    temperature: c.temperature,
    latencyMs: Date.now() - started,
    promptSha256,
    attempts,
    request: sentBody,
    transmitted: payload,
    rawResponse: raw,
  };
  audit('report.response', { payload_sha256: payloadSha256, ms: result.latencyMs, attempts, json_mode: jsonMode, unverified: result.unverifiedNumbers.length });
  return Response.json(result);
}

class HttpError extends Error {}

function post(c: ReturnType<typeof llmConfig>, body: Record<string, unknown>) {
  return fetch(`${c.url}/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(c.apiKey ? { Authorization: `Bearer ${c.apiKey}` } : {}) },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(c.timeoutMs),
  });
}

/**
 * Remove a reasoning section before the answer. MedGemma 1.5 writes "<unused94>thought … <unused95>answer";
 * other reasoning models use <think>…</think>. An unclosed section means the model ran out of tokens while
 * thinking, so nothing after it is an answer.
 */
function stripThinking(raw: string): string {
  let s = raw.replace(/<unused94>[\s\S]*?<unused95>/g, '').replace(/<think>[\s\S]*?<\/think>/gi, '');
  const open = s.search(/<unused94>|<think>/i);
  if (open >= 0) s = s.slice(0, open);
  return s.replace(/<unused\d+>/g, '').trim();
}

/** Accepts a bare object, a fenced ```json block, or an object embedded in prose. Fills missing fields with ''. */
function parseNarrative(reply: string): Narrative | null {
  const raw = stripThinking(reply);
  // The last fenced block is the final answer if the model wrote more than one.
  const blocks = [...raw.matchAll(/```(?:json)?\s*([\s\S]*?)```/gi)].map((m) => m[1]);
  const src = blocks.length ? blocks[blocks.length - 1] : raw;
  const start = src.indexOf('{'), end = src.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  let o: Partial<Record<keyof Narrative, unknown>>;
  try {
    o = JSON.parse(src.slice(start, end + 1));
  } catch {
    try {
      // Common small-model slips: trailing commas, smart quotes.
      o = JSON.parse(src.slice(start, end + 1).replace(/,\s*([}\]])/g, '$1').replace(/[“”]/g, '"'));
    } catch {
      return null;
    }
  }
  if (!o || typeof o !== 'object') return null;
  const s = (v: unknown) => (typeof v === 'string' ? v : v == null ? '' : Array.isArray(v) ? v.join(' ') : String(v));
  const n: Narrative = {
    summary: s(o.summary),
    examination: s(o.examination),
    muscle: s(o.muscle),
    adipose: s(o.adipose),
    recommendations: Array.isArray(o.recommendations) ? o.recommendations.map(s).filter(Boolean) : o.recommendations ? [s(o.recommendations)] : [],
    limitations: s(o.limitations),
  };
  // Reject replies that parsed but carry no report text.
  return n.summary || n.muscle || n.adipose ? n : null;
}

/** Runs in the background when the browser sends X-Async: 1 (see lib/server/jobs.ts). */
export const POST = protect(asyncable(handle));

export const GET = protect(getHandler);
