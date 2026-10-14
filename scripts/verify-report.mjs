// Verify a signed report:  node scripts/verify-report.mjs data/reports/<file>.json [public-key.pem]
// Without a key file, the public key is derived from DATA_DIR/signing-key.pem (run on the server).
import { createHash, createPrivateKey, createPublicKey, verify } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';

const canonical = (v) => {
  if (v === null || typeof v !== 'object') return JSON.stringify(v ?? null);
  if (Array.isArray(v)) return '[' + v.map(canonical).join(',') + ']';
  return '{' + Object.keys(v).filter((k) => v[k] !== undefined).sort().map((k) => JSON.stringify(k) + ':' + canonical(v[k])).join(',') + '}';
};

const [file, keyFile] = process.argv.slice(2);
if (!file) { console.error('usage: node scripts/verify-report.mjs <report.json> [public-key.pem]'); process.exit(2); }
const doc = JSON.parse(readFileSync(file, 'utf8'));
const pub = keyFile
  ? createPublicKey(readFileSync(keyFile, 'utf8'))
  : createPublicKey(createPrivateKey(readFileSync(path.join(process.env.DATA_DIR || './data', 'signing-key.pem'), 'utf8')));
const text = canonical(doc.record);
const hashOk = createHash('sha256').update(text).digest('hex') === doc.sha256;
const sigOk = verify(null, Buffer.from(text, 'utf8'), pub, Buffer.from(doc.signature, 'base64'));
console.log(`hash ${hashOk ? 'OK' : 'MISMATCH'} · signature ${sigOk ? 'VALID' : 'INVALID'} · signed ${doc.record.signed_at} by ${doc.record.reader}`);
process.exit(hashOk && sigOk ? 0 : 1);
