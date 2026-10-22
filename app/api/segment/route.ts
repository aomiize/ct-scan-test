import { NextRequest } from 'next/server';
import { hdr, longPost } from '@/lib/server/long-post';

// Proxies the CT to the segmentation server so the browser never needs direct access to the GPU host.
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 3600;
// A big DICOM series on an edge device can take a long time; override with SEGMENT_TIMEOUT_S.
const TIMEOUT_MS = Number(process.env.SEGMENT_TIMEOUT_S || 3600) * 1000;

const MAX_BYTES = 1024 * 1024 * 1024; // 1 GB

export async function GET() {
  return Response.json({ configured: !!process.env.INFERENCE_URL });
}

export async function POST(req: NextRequest) {
  const target = process.env.INFERENCE_URL;
  if (!target) {
    return new Response('No inference server configured. Set INFERENCE_URL in .env.local and restart.', { status: 501 });
  }
  const len = Number(req.headers.get('content-length') || 0);
  if (len > MAX_BYTES) return new Response('The CT file is larger than 1 GB.', { status: 413 });
  if (!req.body) return new Response('No CT file in the request.', { status: 400 });

  const filename = decodeURIComponent(req.headers.get('x-filename') || 'ct.nii.gz');
  if (!/\.nii(\.gz)?$/i.test(filename)) return new Response('Only .nii or .nii.gz files can be segmented.', { status: 415 });

  const started = Date.now();
  // Audit line: who sent which file and when. Ship stdout to your log collector.
  const user = req.headers.get('x-forwarded-user') || req.headers.get('remote-user') || 'anonymous';
  const ip = req.headers.get('x-forwarded-for') || 'unknown';
  console.log(JSON.stringify({ event: 'segment.request', user, ip, filename, bytes: len, at: new Date().toISOString() }));

  try {
    const upstream = await longPost(
      target,
      req.body,
      {
        'Content-Type': 'application/octet-stream',
        'X-Filename': encodeURIComponent(filename),
        ...(len ? { 'Content-Length': String(len) } : {}),
        ...(process.env.INFERENCE_API_KEY ? { 'X-Api-Key': process.env.INFERENCE_API_KEY } : {}),
      },
      TIMEOUT_MS,
    );

    console.log(JSON.stringify({ event: 'segment.response', user, filename, status: upstream.status, run: hdr(upstream.headers, 'x-run-id'), ms: Date.now() - started }));

    if (upstream.status < 200 || upstream.status >= 300) {
      const detail = (await upstream.text()).slice(0, 500);
      return new Response(`Segmentation server returned HTTP ${upstream.status}. ${detail}`, {
        status: 502,
        headers: { 'X-Run-Id': hdr(upstream.headers, 'x-run-id') },
      });
    }
    return new Response(upstream.body, {
      status: 200,
      headers: {
        'Content-Type': 'application/octet-stream',
        'Cache-Control': 'no-store',
        'X-Label-Scheme': hdr(upstream.headers, 'x-label-scheme') || process.env.INFERENCE_SCHEME || 'generic',
        'X-Run-Id': hdr(upstream.headers, 'x-run-id'),
        'X-Labels': hdr(upstream.headers, 'x-labels'),
        'X-TTA': hdr(upstream.headers, 'x-tta'),
      },
    });
  } catch (err) {
    const e = err as Error;
    console.error(JSON.stringify({ event: 'segment.error', user, filename, error: e.message }));
    const msg = e.name === 'TimeoutError' ? `The segmentation server did not answer within ${TIMEOUT_MS / 60000} minutes (SEGMENT_TIMEOUT_S).` : `Cannot reach the segmentation server (${e.message}).`;
    return new Response(msg, { status: 504 });
  }
}
