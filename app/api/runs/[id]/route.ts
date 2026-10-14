import { inferenceBase, inferenceHeaders } from '@/lib/server/config';

export const dynamic = 'force-dynamic';

export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const base = inferenceBase();
  if (!base) return new Response('No inference server configured.', { status: 501 });
  if (!/^[a-f0-9]{6,32}$/.test(id)) return new Response('Bad run id.', { status: 400 });
  try {
    const r = await fetch(`${base}/runs/${id}`, { headers: inferenceHeaders(), signal: AbortSignal.timeout(10000), cache: 'no-store' });
    return new Response(await r.text(), { status: r.status, headers: { 'Content-Type': 'application/json' } });
  } catch (e) {
    return new Response(`Cannot reach the inference server (${(e as Error).message}).`, { status: 504 });
  }
}
