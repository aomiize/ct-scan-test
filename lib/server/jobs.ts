import 'server-only';
import { randomUUID } from 'node:crypto';
import { NextRequest } from 'next/server';
import { takeUpload, validId } from './uploads';

/**
 * Background jobs for long requests (segmentation, DICOM conversion, report generation).
 *
 * Tunnels and proxies (Cloudflare: 100 s) cut requests that take longer than their limit. When the browser sends
 * "X-Async: 1", the route reads the upload, starts the work in the background and answers 202 {job} at once; the
 * browser then polls /api/jobs/<id> and finally receives the normal response, replayed byte for byte.
 */
interface Job {
  started: number;
  done?: { status: number; headers: [string, string][]; body: ArrayBuffer };
  error?: string;
}

const g = globalThis as unknown as { __bodycompJobs?: Map<string, Job> };
const JOBS = (g.__bodycompJobs ??= new Map());
const KEEP_MS = 30 * 60e3;

function sweep() {
  const now = Date.now();
  for (const [id, j] of JOBS) if (now - j.started > KEEP_MS) JOBS.delete(id);
}

type Handler = (req: NextRequest) => Promise<Response>;

/** Wrap a POST handler so it can run as a background job when the request asks for it. */
export function asyncable(handler: Handler): Handler {
  return async (req) => {
    const uploadId = req.headers.get('x-upload-id');
    if (req.headers.get('x-async') !== '1' && !uploadId) return handler(req);
    sweep();
    // Read the whole upload first: the request is finished once we answer 202. A chunked upload (X-Upload-Id)
    // was already stored piece by piece; take it from disk instead of the request body.
    let body: ArrayBuffer;
    if (uploadId) {
      if (!validId(uploadId)) return new Response('Bad upload id.', { status: 400 });
      try {
        body = await takeUpload(uploadId);
      } catch {
        return new Response('Unknown or expired upload. Try again.', { status: 404 });
      }
    } else body = await req.arrayBuffer();
    const headers = new Headers(req.headers);
    headers.delete('x-upload-id');
    if (req.headers.get('x-async') !== '1') {
      headers.set('content-length', String(body.byteLength));
      return handler(new NextRequest(req.url, { method: 'POST', headers, body }));
    }
    headers.delete('x-async');
    headers.set('content-length', String(body.byteLength));
    const copy = new NextRequest(req.url, { method: 'POST', headers, body });
    const id = randomUUID();
    const job: Job = { started: Date.now() };
    JOBS.set(id, job);
    void (async () => {
      try {
        const r = await handler(copy);
        job.done = { status: r.status, headers: [...r.headers], body: await r.arrayBuffer() };
      } catch (e) {
        job.error = (e as Error).message;
      }
    })();
    return Response.json({ job: id }, { status: 202 });
  };
}

export function jobResponse(id: string): Response {
  const j = JOBS.get(id);
  if (!j) return new Response('Unknown or expired job.', { status: 404 });
  if (j.error) {
    JOBS.delete(id);
    return new Response(`Background job failed: ${j.error}`, { status: 500 });
  }
  if (!j.done) return Response.json({ running: true, seconds: Math.round((Date.now() - j.started) / 1000) }, { status: 202, headers: { 'Cache-Control': 'no-store' } });
  JOBS.delete(id);
  const headers = new Headers(j.done.headers);
  headers.delete('content-length');
  headers.delete('content-encoding');
  return new Response(j.done.body, { status: j.done.status, headers });
}
