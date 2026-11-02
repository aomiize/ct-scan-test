import { protect } from '@/lib/auth';
import { inferenceBase, inferenceHeaders } from '@/lib/server/config';

export const dynamic = 'force-dynamic';

async function getHandler() {
  const base = inferenceBase();
  if (!base) return Response.json({ configured: false });
  try {
    const r = await fetch(`${base}/device`, { headers: inferenceHeaders(), signal: AbortSignal.timeout(5000), cache: 'no-store' });
    if (!r.ok) return Response.json({ configured: true, online: false, error: `HTTP ${r.status}` });
    return Response.json({ configured: true, online: true, ...(await r.json()) });
  } catch (e) {
    const err = e as Error & { cause?: { code?: string } };
    const code = err.name === 'TimeoutError' ? 'no answer within 5 s' : err.cause?.code === 'ECONNREFUSED' ? 'connection refused: the service is not running' : err.cause?.code || err.message;
    return Response.json({ configured: true, online: false, error: code });
  }
}

export const GET = protect(getHandler);
