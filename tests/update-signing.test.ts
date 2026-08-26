/**
 * Signed-release verification primitives (review R1). Uses its OWN test
 * keypair: the real release private key exists only as a GitHub secret and
 * must never appear in code or tests.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { createHash, createPrivateKey, generateKeyPairSync, sign } from 'node:crypto';
import { checksumFromSums, defaultVerifyRelease, sha256Hex, verifySumsSignature } from '../update';

function makeTestKeys(): { pubB64: string; privPem: string } {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  return {
    pubB64: publicKey.export({ format: 'der', type: 'spki' }).toString('base64'),
    privPem: privateKey.export({ format: 'pem', type: 'pkcs8' }).toString(),
  };
}

describe('release verification primitives (R1)', () => {
  const { pubB64, privPem } = makeTestKeys();
  const sums = Buffer.from('a'.repeat(64) + '  broke-v0.9.0.tar.gz\n');

  it('sha256Hex matches node crypto output', () => {
    assert.equal(sha256Hex(Buffer.from('x')), createHash('sha256').update('x').digest('hex'));
  });

  it('verifySumsSignature accepts a valid Ed25519 signature', () => {
    const sig = sign(null, sums, createPrivateKey(privPem));
    assert.equal(verifySumsSignature(sums, sig, pubB64), true);
  });

  it('rejects tampered manifests, wrong keys and empty signatures', () => {
    const sig = sign(null, sums, createPrivateKey(privPem));
    const tampered = Buffer.from('e'.repeat(64) + '  broke-v0.9.0.tar.gz\n');
    assert.equal(verifySumsSignature(tampered, sig, pubB64), false);
    const other = makeTestKeys();
    assert.equal(verifySumsSignature(sums, sig, other.pubB64), false);
    assert.equal(verifySumsSignature(sums, new Uint8Array(0), pubB64), false);
  });

  it('checksumFromSums parses sha256sum format incl. binary marker, matches by name', () => {
    const text = [`${sha256Hex(Buffer.from('a'))}  aaa.tgz`, `${sha256Hex(Buffer.from('b'))}  *bbb.tgz`, ''].join('\n');
    assert.equal(checksumFromSums(text, 'bbb.tgz'), sha256Hex(Buffer.from('b')));
    assert.equal(checksumFromSums(text, 'aaa.tgz'), sha256Hex(Buffer.from('a')));
    assert.equal(checksumFromSums(text, 'missing.tgz'), null);
  });

  it('defaultVerifyRelease accepts a correctly signed + hashed artifact', () => {
    const artifact = Buffer.from('artifact-bytes');
    const name = 'broke-v0.9.0.tar.gz';
    const sumsText = `${createHash('sha256').update(artifact).digest('hex')}  ${name}\n`;
    const good = sign(null, Buffer.from(sumsText, 'utf-8'), createPrivateKey(privPem));
    // Must not throw.
    defaultVerifyRelease(Buffer.from(sumsText), good, artifact, name, pubB64);
  });

  it('throws on tampered manifest, missing manifest entry and hash mismatch', () => {
    const artifact = Buffer.from('artifact-bytes');
    const name = 'broke-v0.9.0.tar.gz';
    const sumsText = `${createHash('sha256').update(artifact).digest('hex')}  ${name}\n`;
    const good = sign(null, Buffer.from(sumsText, 'utf-8'), createPrivateKey(privPem));

    // Tampered manifest -> signature check fails first.
    assert.throws(
      () => defaultVerifyRelease(Buffer.from(sumsText.replace(name, `${name}x`)), good, artifact, name, pubB64),
      /signature verification failed/,
    );
    // Valid signature over a manifest that lacks the artifact's entry.
    const foreignManifest = `${'b'.repeat(64)}  some-other-artifact.tgz\n`;
    assert.throws(
      () =>
        defaultVerifyRelease(
          Buffer.from(foreignManifest),
          sign(null, Buffer.from(foreignManifest, 'utf-8'), createPrivateKey(privPem)),
          artifact,
          name,
          pubB64,
        ),
      /no entry for/,
    );
    // Manifest entry exists but the artifact hash differs (swapped payload).
    const otherArtifact = Buffer.from('evil-bytes');
    assert.throws(
      () => defaultVerifyRelease(Buffer.from(sumsText), good, otherArtifact, name, pubB64),
      /checksum mismatch/,
    );
  });
});
