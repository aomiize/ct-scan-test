import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { NextRequest } from 'next/server';
import type { AnalysisPayload, GeneratedReport, SignatureResult } from '@/lib/report-types';
import { canonical } from '@/lib/server/canonical';
import { audit, dataDir, proxyUser } from '@/lib/server/config';
import { signingKey, signText } from '@/lib/server/signing';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET() {
  const k = signingKey();
  return Response.json({ algorithm: 'Ed25519', fingerprint: k.fingerprint, publicKeyPem: k.pubPem });
}

interface SignRequest {
  payload: AnalysisPayload;
  report: GeneratedReport;
  reader: string;
  remarks: string;
  decision: 'approved' | 'amended';
}

export async function POST(req: NextRequest) {
  let b: SignRequest;
  try {
    b = (await req.json()) as SignRequest;
  } catch {
    return new Response('Invalid JSON.', { status: 400 });
  }
  const reader = (b.reader || '').trim();
  if (!reader) return new Response('Enter the reading physician before signing.', { status: 400 });
  if (b.payload?.schema !== 'bodycomp.metrics/v1' || !b.report?.narrative) return new Response('Missing report or metrics.', { status: 400 });
  if (b.payload.synthetic_sample) return new Response('The synthetic sample cannot be signed.', { status: 400 });

  const authenticatedUser = proxyUser(req.headers);
  const signedAt = new Date().toISOString();
  // What gets signed: metrics, narrative, its provenance, the reader's remarks and identity.
  const record = {
    schema: 'bodycomp.signed-report/v1',
    signed_at: signedAt,
    reader,
    authenticated_user: authenticatedUser,
    decision: b.decision === 'amended' ? 'amended' : 'approved',
    remarks: (b.remarks || '').slice(0, 5000),
    metrics: b.payload,
    narrative: b.report.narrative,
    provenance: {
      source: b.report.source,
      model: b.report.model ?? null,
      prompt_sha256: b.report.promptSha256 ?? null,
      generated_at: b.report.generatedAt,
      unverified_numbers: b.report.unverifiedNumbers,
    },
  };
  const text = canonical(record);
  const sha256 = createHash('sha256').update(text).digest('hex');
  const { signature, fingerprint } = signText(text);

  const dir = path.join(dataDir(), 'reports');
  mkdirSync(dir, { recursive: true });
  const file = `${b.payload.case_ref}_${signedAt.replace(/[:.]/g, '-')}.json`;
  writeFileSync(path.join(dir, file), JSON.stringify({ record, sha256, signature, algorithm: 'Ed25519', key_fingerprint: fingerprint }, null, 2));

  audit('report.signed', { case_ref: b.payload.case_ref, reader, user: authenticatedUser, sha256, file });
  const res: SignatureResult = { sha256, signature, algorithm: 'Ed25519', keyFingerprint: fingerprint, signedAt, reader, authenticatedUser, file };
  return Response.json(res);
}
