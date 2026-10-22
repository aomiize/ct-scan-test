// The standalone server does not include static assets; copy them next to it after `next build`.
import { cpSync, existsSync } from 'node:fs';
cpSync('.next/static', '.next/standalone/.next/static', { recursive: true });
if (existsSync('public')) cpSync('public', '.next/standalone/public', { recursive: true });
// The standalone server reads settings from its own folder, so bring the settings file along.
for (const f of ['.env', '.env.production', '.env.local']) if (existsSync(f)) cpSync(f, `.next/standalone/${f}`);
console.log('Copied static assets into .next/standalone');
