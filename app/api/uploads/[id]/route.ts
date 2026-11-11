import { NextRequest } from 'next/server';
import { protect } from '@/lib/auth';
import { appendUpload, validId } from '@/lib/server/uploads';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** PUT /api/uploads/<id>?offset=N with one piece as the body. Returns {size} received so far. */
async function putHandler(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!validId(id)) return new Response('Bad upload id.', { status: 400 });
  const offset = Number(req.nextUrl.searchParams.get('offset'));
  if (!Number.isInteger(offset) || offset < 0) return new Response('Bad offset.', { status: 400 });
  try {
    const r = await appendUpload(id, offset, new Uint8Array(await req.arrayBuffer()));
    return Response.json({ size: r.size }, { status: r.conflict ? 409 : 200 });
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    const msg = code === 'ENOENT' ? 'Unknown or expired upload. Run segmentation again.' : (e as Error).message;
    return new Response(msg, { status: code === 'ENOENT' ? 404 : code === 'ENOSPC' ? 507 : 500 });
  }
}

export const PUT = protect(putHandler);
