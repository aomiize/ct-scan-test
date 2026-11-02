import 'server-only';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * Chunked uploads. A 60 MB CT sent in one request can be dropped by tunnels or flaky connections ("Failed to
 * fetch"); sent as 4 MB pieces, each piece is retried on its own. Pieces land in a temp file that the long-running
 * route (segment, convert) reads when the browser names it with X-Upload-Id.
 */
const DIR = path.join(os.tmpdir(), 'bodycomp-uploads');
const KEEP_MS = 60 * 60e3;
export const UPLOAD_LIMIT = 1024 ** 3;

export const validId = (id: string) => /^[0-9a-f-]{36}$/.test(id);
export const uploadPath = (id: string) => path.join(DIR, `${id}.part`);

export async function sweepUploads() {
  try {
    const now = Date.now();
    for (const f of await fs.readdir(DIR)) {
      const p = path.join(DIR, f);
      const st = await fs.stat(p).catch(() => null);
      if (st && now - st.mtimeMs > KEEP_MS) await fs.rm(p, { force: true });
    }
  } catch {}
}

export async function createUpload(id: string) {
  await fs.mkdir(DIR, { recursive: true });
  await fs.writeFile(uploadPath(id), new Uint8Array(0));
}

/** Append a piece at the given offset. Re-sent pieces (offset already written) are accepted without writing twice. */
export async function appendUpload(id: string, offset: number, data: Uint8Array): Promise<{ size: number; conflict?: boolean }> {
  const p = uploadPath(id);
  const size = (await fs.stat(p)).size;
  if (offset + data.length <= size) return { size }; // already have it (a retry after a lost reply)
  if (offset !== size) return { size, conflict: true };
  if (size + data.length > UPLOAD_LIMIT) throw new Error('Upload larger than 1 GB.');
  await fs.appendFile(p, data);
  return { size: size + data.length };
}

/** Read a finished upload and delete it. */
export async function takeUpload(id: string): Promise<ArrayBuffer> {
  const p = uploadPath(id);
  const buf = await fs.readFile(p);
  await fs.rm(p, { force: true });
  return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer;
}
