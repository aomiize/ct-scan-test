import { randomUUID } from 'node:crypto';
import { protect } from '@/lib/auth';
import { createUpload, sweepUploads } from '@/lib/server/uploads';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** Start a chunked upload; returns {id}. */
async function postHandler() {
  void sweepUploads();
  const id = randomUUID();
  await createUpload(id);
  return Response.json({ id });
}

export const POST = protect(postHandler);
