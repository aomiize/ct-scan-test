import { NextRequest } from 'next/server';
import { checkLogin, COOKIE, makeSession, redirectTo, safeNext, sessionHours, viaHttps } from '@/lib/auth';
import { audit } from '@/lib/server/config';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// Slow down guessing: after 5 failures from one address, wait 15 minutes.
const FAILS = new Map<string, { n: number; until: number }>();
const MAX = 5, LOCK_MS = 15 * 60e3;

export async function POST(req: NextRequest) {
  const ip = (req.headers.get('x-forwarded-for') || '').split(',')[0].trim() || 'local';
  const form = await req.formData().catch(() => null);
  const user = String(form?.get('user') ?? '');
  const password = String(form?.get('password') ?? '');
  const next = safeNext(String(form?.get('next') ?? '/'));
  const back = (e: string) => {
    const q = new URLSearchParams({ e });
    if (next !== '/') q.set('next', next);
    return redirectTo(`/login?${q}`);
  };

  const f = FAILS.get(ip);
  if (f && f.n >= MAX && Date.now() < f.until) return back('locked');

  const who = checkLogin(user, password);
  if (!who) {
    const n = f && Date.now() < f.until ? f.n + 1 : 1;
    FAILS.set(ip, { n, until: Date.now() + LOCK_MS });
    audit('auth.failed', { ip, user: user.slice(0, 40), attempt: n });
    return back(n >= MAX ? 'locked' : 'bad');
  }
  FAILS.delete(ip);
  audit('auth.login', { ip, user: who });
  const res = redirectTo(next);
  const cookie = [`${COOKIE}=${makeSession(who)}`, 'Path=/', 'HttpOnly', 'SameSite=Lax', `Max-Age=${sessionHours() * 3600}`];
  if (viaHttps(req.headers, req.url)) cookie.push('Secure');
  res.headers.append('Set-Cookie', cookie.join('; '));
  return res;
}
