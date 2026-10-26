import { COOKIE, redirectTo } from '@/lib/auth';

export const dynamic = 'force-dynamic';

export function GET() {
  const res = redirectTo('/login');
  res.headers.append('Set-Cookie', `${COOKIE}=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax`);
  return res;
}
export const POST = GET;
