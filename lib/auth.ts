import { createHash, createHmac, timingSafeEqual } from 'node:crypto';

/**
 * Password login. Off unless APP_PASSWORD or APP_USERS is set.
 *   APP_PASSWORD=one-shared-password          everyone signs in as "staff"
 *   APP_USERS=mon:pass1,prof:pass2            named accounts (the name goes into the audit log and signatures)
 *   SESSION_SECRET=long-random-string         optional; signs the session cookie (derived from the passwords if unset,
 *                                             so changing a password signs everyone out)
 *   SESSION_HOURS=12                          how long a sign-in lasts
 */
export const COOKIE = 'bodycomp_session';

export function accounts(): Map<string, string> {
  const m = new Map<string, string>();
  for (const part of (process.env.APP_USERS || '').split(',')) {
    const i = part.indexOf(':');
    if (i > 0) m.set(part.slice(0, i).trim(), part.slice(i + 1));
  }
  if (process.env.APP_PASSWORD) m.set('staff', process.env.APP_PASSWORD);
  return m;
}

export const authEnabled = () => accounts().size > 0;
export const sessionHours = () => Number(process.env.SESSION_HOURS || 12);

function secret(): string {
  if (process.env.SESSION_SECRET) return process.env.SESSION_SECRET;
  return createHash('sha256').update('bodycomp-session|' + [...accounts()].map(([u, p]) => `${u}:${p}`).sort().join('|')).digest('hex');
}

const sign = (data: string) => createHmac('sha256', secret()).update(data).digest('base64url');

function same(a: string, b: string): boolean {
  const x = createHash('sha256').update(a).digest(), y = createHash('sha256').update(b).digest();
  return timingSafeEqual(x, y) && a.length === b.length;
}

/** Returns the account name if the password matches. With only APP_PASSWORD set, the user name is ignored. */
export function checkLogin(user: string, password: string): string | null {
  const acc = accounts();
  if (acc.size === 1 && acc.has('staff')) return same(password, acc.get('staff')!) ? 'staff' : null;
  const want = acc.get(user.trim());
  // compare anyway so a wrong user name takes as long as a wrong password
  const ok = same(password, want ?? '\u0000no-such-user');
  return ok && want !== undefined ? user.trim() : null;
}

export function makeSession(user: string): string {
  const body = Buffer.from(JSON.stringify({ u: user, exp: Date.now() + sessionHours() * 3600e3 })).toString('base64url');
  return `${body}.${sign(body)}`;
}

export function readSession(token: string | undefined): string | null {
  if (!token) return null;
  const [body, mac] = token.split('.');
  if (!body || !mac || !same(mac, sign(body))) return null;
  try {
    const { u, exp } = JSON.parse(Buffer.from(body, 'base64url').toString()) as { u: string; exp: number };
    if (typeof u !== 'string' || Date.now() > exp || !accounts().has(u)) return null;
    return u;
  } catch {
    return null;
  }
}

/** Only same-site paths are allowed as a post-login destination. */
export const safeNext = (n: string | null | undefined) => (n && n.startsWith('/') && !n.startsWith('//') && !n.startsWith('/api/') ? n : '/');

/**
 * Redirect with a relative Location, so it works behind any tunnel or proxy whatever Host header it forwards.
 */
export function redirectTo(path: string, status = 303): Response {
  return new Response(null, { status, headers: { Location: path, 'Cache-Control': 'no-store' } });
}

/** Whether the browser reached us over HTTPS (directly or through a tunnel), for the cookie's Secure flag. */
export const viaHttps = (h: Headers, url: string) =>
  url.startsWith('https:') || h.get('x-forwarded-proto')?.split(',')[0].trim() === 'https' || /"scheme":"https"/.test(h.get('cf-visitor') || '');

/** Signed-in user from a request's Cookie header, or null. */
export function userFromHeaders(h: Headers): string | null {
  const m = (h.get('cookie') || '').match(new RegExp(`(?:^|;\\s*)${COOKIE}=([^;]+)`));
  return readSession(m?.[1]);
}

/**
 * Guard for API route handlers. API routes are not run through the middleware, because Next.js middleware can
 * consume large request bodies (CT uploads); each route checks the session cookie itself instead.
 */
export function protect<R extends Request, A extends unknown[]>(handler: (req: R, ...rest: A) => Response | Promise<Response>) {
  return async (req: R, ...rest: A): Promise<Response> => {
    if (authEnabled() && !userFromHeaders(req.headers)) return new Response('Sign in first.', { status: 401 });
    return handler(req, ...rest);
  };
}
