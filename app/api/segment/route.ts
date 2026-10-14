import { NextRequest } from 'next/server';

// Proxies the CT to the segmentation server so the browser never needs direct access to the GPU host.
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 900;

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
    const upstream = await fetch(target, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/octet-stream',
        'X-Filename': encodeURIComponent(filename),
        ...(process.env.INFERENCE_API_KEY ? { 'X-Api-Key': process.env.INFERENCE_API_KEY } : {}),
      },
      body: req.body,
      // Required by Node's fetch to stream a request body.
      duplex: 'half',
      signal: AbortSignal.timeout(maxDuration * 1000),
    } as RequestInit & { duplex: 'half' });

    console.log(JSON.stringify({ event: 'segment.response', user, filename, status: upstream.status, run: upstream.headers.get('x-run-id'), ms: Date.now() - started }));

    if (!upstream.ok) {
      const detail = (await upstream.text()).slice(0, 500);
      return new Response(`Segmentation server returned HTTP ${upstream.status}. ${detail}`, { status: 502 });
    }
    return new Response(upstream.body, {
      status: 200,
      headers: {
        'Content-Type': 'application/octet-stream',
        'Cache-Control': 'no-store',
        'X-Label-Scheme': upstream.headers.get('x-label-scheme') || process.env.INFERENCE_SCHEME || 'generic',
        'X-Run-Id': upstream.headers.get('x-run-id') || '',
      },
    });
  } catch (err) {
    const e = err as Error;
    console.error(JSON.stringify({ event: 'segment.error', user, filename, error: e.message }));
    const msg = e.name === 'TimeoutError' ? 'The segmentation server did not answer in time.' : `Cannot reach the segmentation server (${e.message}).`;
    return new Response(msg, { status: 504 });
  }
}
