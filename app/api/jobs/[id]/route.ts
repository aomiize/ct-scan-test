import { protect } from '@/lib/auth';
import { jobResponse } from '@/lib/server/jobs';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

async function getHandler(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  return jobResponse((await params).id);
}

export const GET = protect(getHandler);
