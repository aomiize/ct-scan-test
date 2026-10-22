import 'server-only';
import http from 'node:http';
import https from 'node:https';
import { Readable } from 'node:stream';

/**
 * POST a streamed body and wait as long as it takes for the answer.
 *
 * Node's built-in fetch gives up if response headers have not arrived within 5 minutes (undici headersTimeout),
 * and the segmentation server only answers once the model has finished. A large DICOM series on an edge device
 * can take longer than that, so these calls use node:http with only our own overall timeout.
 */
export function longPost(
  url: string,
  body: ReadableStream<Uint8Array> | Blob | null,
  headers: Record<string, string>,
  timeoutMs: number,
): Promise<{ status: number; headers: http.IncomingHttpHeaders; body: ReadableStream<Uint8Array>; text: () => Promise<string> }> {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const lib = u.protocol === 'https:' ? https : http;
    const req = lib.request(u, { method: 'POST', headers, timeout: 0 }, (res) => {
      clearTimeout(timer);
      resolve({
        status: res.statusCode ?? 502,
        headers: res.headers,
        body: Readable.toWeb(res) as unknown as ReadableStream<Uint8Array>,
        text: async () => {
          const chunks: Buffer[] = [];
          for await (const c of res) chunks.push(c as Buffer);
          return Buffer.concat(chunks).toString('utf8');
        },
      });
    });
    const timer = setTimeout(() => {
      const e = new Error('timeout');
      e.name = 'TimeoutError';
      req.destroy(e);
    }, timeoutMs);
    req.on('error', (e) => {
      clearTimeout(timer);
      reject(e);
    });
    if (!body) return req.end();
    const src = body instanceof Blob ? Readable.fromWeb(body.stream() as never) : Readable.fromWeb(body as never);
    src.on('error', (e) => req.destroy(e));
    src.pipe(req);
  });
}

/** First value of a response header as a string. */
export const hdr = (h: http.IncomingHttpHeaders, name: string) => {
  const v = h[name.toLowerCase()];
  return Array.isArray(v) ? v[0] ?? '' : v ?? '';
};
