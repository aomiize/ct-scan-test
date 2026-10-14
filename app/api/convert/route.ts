import { NextRequest } from 'next/server';
import { audit, inferenceBase, inferenceHeaders, proxyUser } from '@/lib/server/config';

// DICOM .zip → NIfTI, done on the inference server (SimpleITK). Patient metadata does not survive the conversion.
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 300;

export async function POST(req: NextRequest) {
  const base = inferenceBase();
  if (!base) return new Response('DICOM conversion runs on the inference server. Set INFERENCE_URL in .env.local.', { status: 501 });
  if (!req.body) return new Response('No DICOM upload in the request.', { status: 400 });
  const bytes = Number(req.headers.get('content-length') || 0);
  audit('dicom.convert', { user: proxyUser(req.headers), bytes });
  try {
    const up = await fetch(`${base}/convert`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/zip',
        ...inferenceHeaders(),
        ...(req.headers.get('x-series-id') ? { 'X-Series-Id': req.headers.get('x-series-id')! } : {}),
      },
      body: req.body,
      duplex: 'half',
      signal: AbortSignal.timeout(maxDuration * 1000),
    } as RequestInit & { duplex: 'half' });
    if (!up.ok) {
      const t = await up.text();
      let detail = t;
      try { detail = (JSON.parse(t) as { detail?: string }).detail ?? t; } catch {}
      return new Response(`DICOM conversion failed (HTTP ${up.status}). ${detail.slice(0, 400)}`, { status: up.status === 422 || up.status === 400 ? up.status : 502 });
    }
    return new Response(up.body, {
      headers: {
        'Content-Type': 'application/octet-stream',
        'Cache-Control': 'no-store',
        'X-Series': up.headers.get('x-series') ?? '',
        'X-Series-Chosen': up.headers.get('x-series-chosen') ?? '',
      },
    });
  } catch (e) {
    const err = e as Error;
    return new Response(err.name === 'TimeoutError' ? 'The inference server did not finish converting in time.' : `Cannot reach the inference server (${err.message}).`, { status: 504 });
  }
}
