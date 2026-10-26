import { redirect } from 'next/navigation';
import { accounts, authEnabled, safeNext } from '@/lib/auth';

export const dynamic = 'force-dynamic';

const MESSAGES: Record<string, string> = {
  bad: 'Wrong user name or password.',
  locked: 'Too many failed attempts. Try again in 15 minutes.',
};

export default async function Login({ searchParams }: { searchParams: Promise<{ e?: string; next?: string }> }) {
  if (!authEnabled()) redirect('/');
  const { e, next } = await searchParams;
  const named = !(accounts().size === 1 && accounts().has('staff'));
  return (
    <main className="login-wrap">
      <form className="login" method="post" action="/api/login">
        <h1>BodyComp</h1>
        <p className="note">CT body composition workstation · authorised users only</p>
        {e && MESSAGES[e] && <p className="banner warn">{MESSAGES[e]}</p>}
        <input type="hidden" name="next" value={safeNext(next)} />
        {named && (
          <label>
            User name
            <input name="user" autoComplete="username" required autoFocus />
          </label>
        )}
        <label>
          Password
          <input name="password" type="password" autoComplete="current-password" required autoFocus={!named} />
        </label>
        <button type="submit" className="btn primary">Sign in</button>
      </form>
    </main>
  );
}
