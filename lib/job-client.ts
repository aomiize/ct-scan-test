/**
 * POST that survives proxies with short timeouts: asks the server to run the work as a background job and polls
 * for the result. Returns the final Response exactly as a normal fetch would. Works with servers that ignore
 * X-Async too (their normal response is returned directly).
 */
export async function postJob(url: string, init: RequestInit, onWait?: (seconds: number) => void): Promise<Response> {
  const headers = new Headers(init.headers);
  headers.set('X-Async', '1');
  const first = await fetch(url, { ...init, method: 'POST', headers });
  if (first.status !== 202) return first;
  const { job } = (await first.json()) as { job: string };
  for (;;) {
    await new Promise((r) => setTimeout(r, 2000));
    let r: Response;
    try {
      r = await fetch(`/api/jobs/${job}`, { cache: 'no-store' });
    } catch {
      continue; // brief network hiccup: keep polling
    }
    if (r.status !== 202) return r;
    try {
      onWait?.(((await r.json()) as { seconds: number }).seconds);
    } catch {}
  }
}
