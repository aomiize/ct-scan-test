import { authEnabled, userFromHeaders } from '@/lib/auth';

export const dynamic = 'force-dynamic';

export function GET(req: Request) {
  return Response.json({ auth: authEnabled(), user: authEnabled() ? userFromHeaders(req.headers) : null });
}
