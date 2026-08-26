#!/usr/bin/env node
/**
 * Release artifact signing (review R1).
 *
 * Computes the sha256sum-format manifest for one or more release artifacts
 * and signs it with Ed25519. Used by .github/workflows/release.yml; can be
 * run locally for a dry run.
 *
 * Usage:
 *   BROKE_RELEASE_SIGNING_KEY=<pkcs8 pem> node scripts/sign-release.mjs <artifact> [artifact...]
 *
 * Outputs next to the first artifact:
 *   SHA256SUMS      "<hex>  <basename>" per line (LF, trailing newline)
 *   SHA256SUMS.sig  Ed25519 signature over the exact SHA256SUMS bytes
 *
 * The private key NEVER leaves the CI secret / local machine - it must not
 * be committed and is not needed by the updater (which embeds only the
 * public key).
 */
import { createHash, createPrivateKey, sign } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';

const keyPem = process.env.BROKE_RELEASE_SIGNING_KEY;
if (!keyPem) {
  console.error('BROKE_RELEASE_SIGNING_KEY is not set - refusing to produce unsigned release artifacts.');
  process.exit(1);
}
const artifacts = process.argv.slice(2);
if (artifacts.length === 0) {
  console.error('usage: node scripts/sign-release.mjs <artifact> [artifact...]');
  process.exit(1);
}

// Deterministic manifest: sorted by file name, LF endings, trailing newline.
const lines = artifacts
  .map((p) => {
    const data = readFileSync(p);
    return `${createHash('sha256').update(data).digest('hex')}  ${basename(p)}`;
  })
  .sort();
// Trailing newline is part of the SIGNED bytes - keep writeFileSync on the
// same string so what is written is exactly what was signed.
const sumsContent = `${lines.join('\n')}\n`;

let privateKey;
try {
  privateKey = createPrivateKey(keyPem);
} catch (err) {
  console.error(`BROKE_RELEASE_SIGNING_KEY is not a readable private key (${err instanceof Error ? err.message : err})`);
  process.exit(1);
}
if (privateKey.asymmetricKeyType !== 'ed25519') {
  console.error(`BROKE_RELEASE_SIGNING_KEY must be an Ed25519 key (got: ${String(privateKey.asymmetricKeyType)})`);
  process.exit(1);
}

const sumsBuf = Buffer.from(sumsContent, 'utf-8');
const signature = sign(null, sumsBuf, privateKey);

const outDir = dirname(artifacts[0]);
writeFileSync(join(outDir, 'SHA256SUMS'), sumsBuf);
writeFileSync(join(outDir, 'SHA256SUMS.sig'), signature);
console.log(sumsContent.trimEnd());
console.log('SHA256SUMS + SHA256SUMS.sig written.');
