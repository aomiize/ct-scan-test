import { readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { casesDir } from '@/lib/server/config';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const NII = /\.nii(\.gz)?$/i;
const MASK = /(seg|mask|label|lbl)/i;

/** Lists CT volumes in CASES_DIR and pairs each with a mask whose name starts with the same stem. */
export async function GET() {
  const dir = casesDir();
  if (!dir) return Response.json({ configured: false, cases: [] });
  let names: string[];
  try {
    names = readdirSync(dir).filter((n) => NII.test(n));
  } catch (e) {
    return Response.json({ configured: true, error: `Cannot read CASES_DIR (${(e as Error).message}).`, cases: [] });
  }
  const masks = names.filter((n) => MASK.test(n));
  const cts = names.filter((n) => !MASK.test(n));
  const cases = cts
    .map((n) => {
      const st = statSync(path.join(dir, n));
      const stem = n.replace(NII, '').replace(/_(ct|image|img|0000)$/i, '');
      const mask = masks.find((m) => m.startsWith(stem)) ?? null;
      return { name: n, bytes: st.size, modified: st.mtime.toISOString(), mask };
    })
    .sort((a, b) => b.modified.localeCompare(a.modified));
  return Response.json({ configured: true, cases });
}
