import { inferenceBase, inferenceHeaders } from '@/lib/server/config';

export const dynamic = 'force-dynamic';

export async function GET() {
  const base = inferenceBase();
  if (!base) return Response.json({ configured: false });
  try {
    const r = await fetch(`${base}/device`, { headers: inferenceHeaders(), signal: AbortSignal.timeout(5000), cache: 'no-store' });
    if (!r.ok) return Response.json({ configured: true, online: false, error: `HTTP ${r.status}` });
    return Response.json({ configured: true, online: true, ...(await r.json()) });
  } catch (e) {
    return Response.json({ configured: true, online: false, error: (e as Error).message });
  }
}
