import 'server-only';
import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync, KeyObject, sign } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { dataDir } from './config';

let cached: { priv: KeyObject; pubPem: string; fingerprint: string } | null = null;

/**
 * Ed25519 key for signing approved reports.
 * SIGNING_KEY_PEM (PKCS#8) wins; otherwise a key is created once in DATA_DIR/signing-key.pem (mode 600).
 */
export function signingKey() {
  if (cached) return cached;
  let pem = process.env.SIGNING_KEY_PEM?.replace(/\\n/g, '\n');
  if (!pem) {
    const file = path.join(dataDir(), 'signing-key.pem');
    if (existsSync(file)) pem = readFileSync(file, 'utf8');
    else {
      mkdirSync(dataDir(), { recursive: true });
      const { privateKey } = generateKeyPairSync('ed25519');
      pem = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
      writeFileSync(file, pem, { mode: 0o600 });
    }
  }
  const priv = createPrivateKey(pem);
  const pub = createPublicKey(priv);
  const pubPem = pub.export({ type: 'spki', format: 'pem' }).toString();
  const der = pub.export({ type: 'spki', format: 'der' });
  const fingerprint = createHash('sha256').update(der).digest('hex').slice(0, 16);
  cached = { priv, pubPem, fingerprint };
  return cached;
}

export function signText(text: string) {
  const k = signingKey();
  return { signature: sign(null, Buffer.from(text, 'utf8'), k.priv).toString('base64'), fingerprint: k.fingerprint };
}
