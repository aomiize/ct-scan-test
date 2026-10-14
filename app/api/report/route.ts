import { createHash } from 'node:crypto';
import { NextRequest } from 'next/server';
import { unverifiedNumbers } from '@/lib/payload';
import type { AnalysisPayload, GeneratedReport, Narrative } from '@/lib/report-types';
import { audit, llmConfig, proxyUser } from '@/lib/server/config';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 180;

const SYSTEM = `You draft CT body-composition reports for a radiologist, who will review and sign them.
Rules:
- Use only the numbers in the JSON you are given. Never invent, estimate or convert values.
- If a value is null, say it is not available.
- A finding is abnormal only if its entry in "references" has flagged=true. Do not apply other cut-offs.
- Mention every item in "quality_flags" under limitations.
- Be concise and clinical. No patient identifiers exist in the data; do not make any up.
Reply with one JSON object and nothing else:
{"summary": string, "examination": string, "muscle": string, "adipose": string, "recommendations": string[], "limitations": string}`;

const RETRY_NOTE = 'Your previous reply was not a valid JSON object. Reply again with only the JSON object described in the instructions: no markdown, no code fences, no other text.';

type Msg = { role: 'system' | 'user' | 'assistant'; content: string };

export async function GET() {
  const c = llmConfig();
  return Response.json({ configured: !!c.url, model: c.url ? c.model : null });
}

export async function POST(req: NextRequest) {
  const c = llmConfig();
  if (!c.url) return new Response('No language model configured. Set LLM_URL in .env.local.', { status: 501 });

  let payload: AnalysisPayload;
  try {
    payload = (await req.json()) as AnalysisPayload;
    if (payload?.schema !== 'bodycomp.metrics/v1') throw new Error();
  } catch {
    return new Response('Request body must be a bodycomp.metrics/v1 payload.', { status: 400 });
  }

  const messages: Msg[] = [
    { role: 'system', content: SYSTEM },
    { role: 'user', content: `Body-composition measurements:\n${JSON.stringify(payload, null, 2)}` },
  ];
  const promptSha256 = createHash('sha256').update(JSON.stringify(messages)).digest('hex');
  const started = Date.now();
  audit('report.request', { user: proxyUser(req.headers), case_ref: payload.case_ref, model: c.model, prompt_sha256: promptSha256 });

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
      audit('report.unparsable', { case_ref: payload.case_ref, attempt: attempts, start: raw.slice(0, 120) });
    }
  } catch (e) {
    const err = e as Error;
    audit('report.error', { case_ref: payload.case_ref, error: err.message });
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
    unverifiedNumbers: unverifiedNumbers(text, payload),
    model: c.model,
    temperature: c.temperature,
    latencyMs: Date.now() - started,
    promptSha256,
    attempts,
    request: sentBody,
    rawResponse: raw,
  };
  audit('report.response', { case_ref: payload.case_ref, ms: result.latencyMs, attempts, json_mode: jsonMode, unverified: result.unverifiedNumbers.length });
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
