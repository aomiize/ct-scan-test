import { createReadStream, statSync } from 'node:fs';
import path from 'node:path';
import { Readable } from 'node:stream';
import { NextRequest } from 'next/server';
import { audit, casesDir, proxyUser } from '@/lib/server/config';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest, ctx: { params: Promise<{ name: string }> }) {
  const dir = casesDir();
  if (!dir) return new Response('CASES_DIR is not configured.', { status: 501 });
  const name = decodeURIComponent((await ctx.params).name);
  // Only plain file names inside CASES_DIR.
  if (name !== path.basename(name) || !/\.nii(\.gz)?$/i.test(name)) return new Response('Bad file name.', { status: 400 });
  const file = path.join(dir, name);
  let size: number;
  try {
    size = statSync(file).size;
  } catch {
    return new Response('File not found.', { status: 404 });
  }
  audit('case.open', { user: proxyUser(req.headers), name, bytes: size });
  const stream = Readable.toWeb(createReadStream(file)) as ReadableStream;
  return new Response(stream, { headers: { 'Content-Type': 'application/octet-stream', 'Content-Length': String(size), 'Cache-Control': 'no-store' } });
}
