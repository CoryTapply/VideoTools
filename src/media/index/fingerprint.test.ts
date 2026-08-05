import { describe, expect, it } from 'vitest';
import { computeFingerprint, fingerprintsEqual } from './fingerprint';
import { BufferByteSource } from './sources/buffer-byte-source';

describe('computeFingerprint', () => {
  it('is stable for the same bytes and lastModified', async () => {
    const bytes = Uint8Array.from({ length: 5000 }, (_, i) => i % 256);
    const a = await computeFingerprint(new BufferByteSource(bytes), 12345);
    const b = await computeFingerprint(new BufferByteSource(bytes), 12345);
    expect(fingerprintsEqual(a, b)).toBe(true);
  });

  it('differs when only a tail byte changes (proves the tail window is actually hashed)', async () => {
    const bytes = Uint8Array.from({ length: 5000 }, (_, i) => i % 256);
    const changed = bytes.slice();
    changed[changed.length - 1] = (changed[changed.length - 1] + 1) % 256;
    const a = await computeFingerprint(new BufferByteSource(bytes), 12345);
    const b = await computeFingerprint(new BufferByteSource(changed), 12345);
    expect(fingerprintsEqual(a, b)).toBe(false);
  });

  it('differs when lastModified changes even if content and size are identical', async () => {
    const bytes = Uint8Array.from({ length: 100 }, (_, i) => i);
    const a = await computeFingerprint(new BufferByteSource(bytes), 1);
    const b = await computeFingerprint(new BufferByteSource(bytes), 2);
    expect(fingerprintsEqual(a, b)).toBe(false);
  });

  it('handles a file smaller than the 1MB hash window without error', async () => {
    const bytes = Uint8Array.from([1, 2, 3]);
    const fp = await computeFingerprint(new BufferByteSource(bytes), 0);
    expect(fp.size).toBe(3);
  });
});
