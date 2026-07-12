import { createHash } from 'node:crypto';
import { deflateRawSync, inflateRawSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { PAYLOAD_LIMITS, safeTruncateFileSnapshot } from '../payload-truncate';
import {
  assertStoredSnapshotMatches,
  decodeFileSnapshotBlob,
  encodeFileSnapshot,
  encodePersistedFileSnapshot,
  FILE_SNAPSHOT_CODEC,
} from '../file-snapshot-codec';

describe('file snapshot codec', () => {
  it('hashes exact truncated UTF-8 and uses raw deflate level 1', () => {
    const source = 'a'.repeat(PAYLOAD_LIMITS.MAX_FILE_SNAPSHOT_BYTES + 16);
    const truncated = safeTruncateFileSnapshot(source)!;
    const expectedRaw = Buffer.from(truncated, 'utf8');
    const encoded = encodeFileSnapshot(source)!;

    expect(encoded.raw.equals(expectedRaw)).toBe(true);
    expect(encoded.digest.equals(createHash('sha256').update(expectedRaw).digest())).toBe(true);
    expect(encoded.data.equals(deflateRawSync(expectedRaw, { level: 1 }))).toBe(true);
    expect(inflateRawSync(encoded.data).equals(expectedRaw)).toBe(true);
  });

  it('round trips empty and multibyte snapshots', () => {
    for (const source of ['', 'hello\n世界 🦄']) {
      const encoded = encodeFileSnapshot(source)!;
      expect(
        decodeFileSnapshotBlob(encoded.digest, {
          codec: FILE_SNAPSHOT_CODEC,
          rawBytes: encoded.rawBytes,
          compressedBytes: encoded.compressedBytes,
          data: encoded.data,
        }),
      ).toBe(source);
    }
    expect(encodeFileSnapshot(null)).toBeNull();
  });

  it('does not truncate an already-persisted v040 truncation marker a second time', () => {
    const source = 'a'.repeat(PAYLOAD_LIMITS.MAX_FILE_SNAPSHOT_BYTES + 16);
    const persisted = safeTruncateFileSnapshot(source)!;
    expect(Buffer.byteLength(persisted, 'utf8')).toBeGreaterThan(
      PAYLOAD_LIMITS.MAX_FILE_SNAPSHOT_BYTES,
    );

    const encoded = encodePersistedFileSnapshot(persisted)!;
    expect(encoded.raw.toString('utf8')).toBe(persisted);
    expect(encoded.digest.equals(createHash('sha256').update(persisted).digest())).toBe(true);
  });

  it('rejects invalid lengths, compressed data, digests, and UTF-8', () => {
    const encoded = encodeFileSnapshot('valid')!;
    const stored = {
      codec: FILE_SNAPSHOT_CODEC,
      rawBytes: encoded.rawBytes,
      compressedBytes: encoded.compressedBytes,
      data: encoded.data,
    };
    expect(() => decodeFileSnapshotBlob(encoded.digest, { ...stored, rawBytes: 999 })).toThrow();
    expect(() =>
      decodeFileSnapshotBlob(encoded.digest, { ...stored, compressedBytes: 999 }),
    ).toThrow();
    expect(() => decodeFileSnapshotBlob(Buffer.alloc(32), stored)).toThrow(
      /digest verification/,
    );

    const invalidUtf8 = Buffer.from([0xff]);
    const invalidDigest = createHash('sha256').update(invalidUtf8).digest();
    const invalidData = deflateRawSync(invalidUtf8, { level: 1 });
    expect(() =>
      decodeFileSnapshotBlob(invalidDigest, {
        codec: FILE_SNAPSHOT_CODEC,
        rawBytes: invalidUtf8.length,
        compressedBytes: invalidData.length,
        data: invalidData,
      }),
    ).toThrow(/not valid UTF-8/);
  });

  it('verifies inflated bytes when a digest insert conflicts', () => {
    const expected = encodeFileSnapshot('expected')!;
    expect(() =>
      assertStoredSnapshotMatches(expected, {
        codec: FILE_SNAPSHOT_CODEC,
        rawBytes: expected.rawBytes,
        compressedBytes: expected.compressedBytes,
        data: expected.data,
      }),
    ).not.toThrow();

    const otherRaw = Buffer.from('other---');
    const otherData = deflateRawSync(otherRaw, { level: 1 });
    expect(() =>
      assertStoredSnapshotMatches(expected, {
        codec: FILE_SNAPSHOT_CODEC,
        rawBytes: otherRaw.length,
        compressedBytes: otherData.length,
        data: otherData,
      }),
    ).toThrow(/failed digest verification/);
  });
});
