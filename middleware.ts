import { NextRequest, NextResponse } from 'next/server';
import { authEnabled, COOKIE, readSession } from '@/lib/auth';

// Node.js runtime so the session check reads settings at run time and can use node:crypto.
export const config = {
  runtime: 'nodejs',
  // API routes check the session themselves (lib/auth.ts protect): middleware must not touch upload bodies.
  matcher: ['/((?!api/|_next/static|_next/image|icon.svg|favicon.ico).*)'],
};

const PUBLIC = new Set(['/login']);

export function middleware(req: NextRequest) {
  if (!authEnabled()) return NextResponse.next();
  const { pathname, search } = req.nextUrl;
  if (PUBLIC.has(pathname)) return NextResponse.next();

  const user = readSession(req.cookies.get(COOKIE)?.value);
  if (!user) {
    // Show the sign-in page in place (an internal rewrite, so no Host-dependent redirect is needed behind tunnels).
    const url = req.nextUrl.clone();
    url.pathname = '/login';
    url.search = pathname === '/' ? '' : `?next=${encodeURIComponent(pathname + search)}`;
    return NextResponse.rewrite(url);
  }
  return NextResponse.next();
}
