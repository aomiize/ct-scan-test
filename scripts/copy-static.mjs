// The standalone server does not include static assets; copy them next to it after `next build`.
import { cpSync, existsSync } from 'node:fs';
cpSync('.next/static', '.next/standalone/.next/static', { recursive: true });
if (existsSync('public')) cpSync('public', '.next/standalone/public', { recursive: true });
console.log('Copied static assets into .next/standalone');
