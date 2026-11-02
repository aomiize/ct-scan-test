/**
 * Long requests that survive tunnels, proxies and flaky connections.
 *
 * - Large bodies (CT volumes, DICOM zips) are uploaded in 4 MB pieces; each piece is retried on its own.
 * - The work runs as a background job on the server and the browser polls for the result, so no single request
 *   has to stay open for minutes (tunnels cut those).
 * - Network failures become messages that say what happened instead of "Failed to fetch".
 */
const CHUNK = 4 * 1024 * 1024;
const RETRIES = 4;

export type Progress = (p: { phase: 'upload' | 'wait'; done?: number; total?: number; seconds?: number }) => void;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export class ConnectionError extends Error {}

function lost(what: string): ConnectionError {
  const offline = typeof navigator !== 'undefined' && navigator.onLine === false;
  return new ConnectionError(
    offline
      ? `Your device is offline (${what}). Check the internet connection and try again.`
      : `Lost the connection to the web server ${what}. The server may be offline or asleep, or the network dropped. Wait a moment and try again; if it keeps happening, check that the machine running the web app is on.`,
  );
}

/** fetch with retries on network errors and 502/503/504 from a tunnel. */
async function fetchRetry(url: string, init: RequestInit, what: string): Promise<Response> {
  for (let attempt = 0; ; attempt++) {
    try {
      const r = await fetch(url, init);
      if ((r.status === 502 || r.status === 503 || r.status === 504) && attempt < RETRIES && !r.headers.get('x-run-id')) {
        // a gateway hiccup in front of the app; our own 502/504 carry a message and are returned to the caller
        const text = await r.clone().text();
        if (!text || /bad gateway|gateway time|service unavailable|<html/i.test(text)) {
          await sleep(1000 * 2 ** attempt);
          continue;
        }
      }
      return r;
    } catch {
      if (attempt >= RETRIES) throw lost(what);
      await sleep(1000 * 2 ** attempt);
    }
  }
}

async function uploadChunked(body: Blob, onProgress?: Progress): Promise<string> {
  const start = await fetchRetry('/api/uploads', { method: 'POST' }, 'while starting the upload');
  if (!start.ok) throw new Error(`Upload could not start (HTTP ${start.status}). ${(await start.text()).slice(0, 200)}`);
  const { id } = (await start.json()) as { id: string };
  let offset = 0;
  onProgress?.({ phase: 'upload', done: 0, total: body.size });
  while (offset < body.size) {
    const piece = body.slice(offset, offset + CHUNK);
    const r = await fetchRetry(`/api/uploads/${id}?offset=${offset}`, { method: 'PUT', body: piece, headers: { 'Content-Type': 'application/octet-stream' } }, `while uploading (${Math.round((offset / body.size) * 100)}% sent)`);
    if (r.status === 409) {
      offset = ((await r.json()) as { size: number }).size; // server has a different amount; continue from there
      continue;
    }
    if (!r.ok) throw new Error(`Upload failed (HTTP ${r.status}). ${(await r.text()).slice(0, 200)}`);
    offset = ((await r.json()) as { size: number }).size;
    onProgress?.({ phase: 'upload', done: offset, total: body.size });
  }
  return id;
}

/** POST as a background job and wait for the result. Returns the final Response exactly as a normal fetch would. */
export async function postJob(url: string, init: RequestInit, onProgress?: Progress): Promise<Response> {
  const report: Progress = (p) => {
    try {
      onProgress?.(p);
    } catch {}
  };
  const headers = new Headers(init.headers);
  headers.set('X-Async', '1');
  let body = init.body ?? null;
  if (body instanceof Blob && body.size > CHUNK) {
    const id = await uploadChunked(body, report);
    headers.set('X-Upload-Id', id);
    body = null;
  }
  const first = await fetchRetry(url, { ...init, method: 'POST', headers, body }, 'while starting the job');
  if (first.status !== 202) return first;
  const { job } = (await first.json()) as { job: string };
  let failures = 0;
  const started = Date.now();
  for (;;) {
    await sleep(2000);
    let r: Response;
    try {
      r = await fetch(`/api/jobs/${job}`, { cache: 'no-store' });
    } catch {
      // keep polling through short drops; give up after about two minutes without any answer
      if (++failures >= 40) throw lost('while waiting for the result');
      continue;
    }
    if (r.status === 502 || r.status === 503 || r.status === 504) {
      if (++failures >= 40) throw lost('while waiting for the result');
      continue;
    }
    failures = 0;
    if (r.status === 404) throw new Error('The web server lost this job (it was probably restarted). Run it again.');
    if (r.status !== 202) return r;
    let seconds = Math.round((Date.now() - started) / 1000);
    try {
      seconds = ((await r.json()) as { seconds: number }).seconds;
    } catch {}
    report({ phase: 'wait', seconds });
  }
}
