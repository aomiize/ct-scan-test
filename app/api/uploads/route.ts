import { randomUUID } from 'node:crypto';
import { NextRequest } from 'next/server';
import { protect } from '@/lib/auth';
import { createUpload, diskFullMessage, freeSpace, sweepUploads, UPLOAD_LIMIT } from '@/lib/server/uploads';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Start a chunked upload; returns {id}. With ?size=N it first checks there is room: the upload is stored once and
 * then read into memory, and the segmentation server on the same machine needs space for its own copy too.
 */
async function postHandler(req: NextRequest) {
  await sweepUploads();
  const size = Number(req.nextUrl.searchParams.get('size') || 0);
  if (size > UPLOAD_LIMIT) return new Response('This file is larger than 1 GB, the upload limit.', { status: 413 });
  if (size > 0) {
    const free = await freeSpace();
    // keep a margin: the file itself, the segmentation copy on an edge device running both, and 500 MB spare
    if (free != null && free < size * 2 + 500e6) return new Response(diskFullMessage(free, size * 2 + 500e6), { status: 507 });
  }
  const id = randomUUID();
  await createUpload(id);
  return Response.json({ id });
}

export const POST = protect(postHandler);
