import { createHash } from 'node:crypto';
import { TextDecoder } from 'node:util';
import { deflateRawSync, inflateRawSync } from 'node:zlib';
import { PAYLOAD_LIMITS, safeTruncateFileSnapshot } from './payload-truncate';

export const FILE_SNAPSHOT_CODEC = 'deflate-raw-1' as const;
const SHA256_BYTES = 32;
const MAX_STORED_RAW_BYTES = PAYLOAD_LIMITS.MAX_FILE_SNAPSHOT_BYTES + 4 * 1024;
const MAX_STORED_COMPRESSED_BYTES = PAYLOAD_LIMITS.MAX_FILE_SNAPSHOT_BYTES + 64 * 1024;
const utf8Decoder = new TextDecoder('utf-8', { fatal: true });

export interface EncodedFileSnapshot {
  digest: Buffer;
  digestHex: string;
  raw: Buffer;
  rawBytes: number;
  compressedBytes: number;
  data: Buffer;
}

export interface StoredFileSnapshotBlob {
  codec: unknown;
  rawBytes: unknown;
  compressedBytes: unknown;
  data: unknown;
}

export class FileSnapshotBlobError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'FileSnapshotBlobError';
  }
}

export function encodeFileSnapshot(
  snapshot: string | null | undefined,
): EncodedFileSnapshot | null {
  const truncated = safeTruncateFileSnapshot(snapshot);
  if (truncated === null) return null;
  return encodeRawSnapshot(Buffer.from(truncated, 'utf8'));
}

/** Preserve an already-persisted v040 snapshot byte-for-byte; it may already include a marker. */
export function encodePersistedFileSnapshot(
  snapshot: string | null | undefined,
): EncodedFileSnapshot | null {
  if (snapshot == null) return null;
  const raw = Buffer.from(snapshot, 'utf8');
  if (raw.length > MAX_STORED_RAW_BYTES) {
    throw new FileSnapshotBlobError(
      `persisted snapshot exceeds compatibility bound (${raw.length} bytes)`,
    );
  }
  return encodeRawSnapshot(raw);
}

function encodeRawSnapshot(raw: Buffer): EncodedFileSnapshot {
  const digest = createHash('sha256').update(raw).digest();
  const data = deflateRawSync(raw, { level: 1 });
  return {
    digest,
    digestHex: digest.toString('hex'),
    raw,
    rawBytes: raw.length,
    compressedBytes: data.length,
    data,
  };
}

export function snapshotDigestKey(digest: unknown): string | null {
  return Buffer.isBuffer(digest) && digest.length === SHA256_BYTES
    ? digest.toString('hex')
    : null;
}

export function decodeFileSnapshotBlob(
  expectedDigest: Buffer,
  stored: StoredFileSnapshotBlob,
): string {
  const raw = inflateAndValidate(expectedDigest, stored);
  try {
    return utf8Decoder.decode(raw);
  } catch (err) {
    throw new FileSnapshotBlobError(
      `snapshot ${expectedDigest.toString('hex')} is not valid UTF-8: ${errorMessage(err)}`,
    );
  }
}

export function assertStoredSnapshotMatches(
  expected: EncodedFileSnapshot,
  stored: StoredFileSnapshotBlob | undefined,
): void {
  if (!stored) {
    throw new FileSnapshotBlobError(
      `snapshot digest conflict did not resolve to a row (${expected.digestHex})`,
    );
  }
  const raw = inflateAndValidate(expected.digest, stored);
  if (!raw.equals(expected.raw)) {
    throw new FileSnapshotBlobError(
      `snapshot digest conflict inflated to different bytes (${expected.digestHex})`,
    );
  }
}

function inflateAndValidate(expectedDigest: Buffer, stored: StoredFileSnapshotBlob): Buffer {
  const digestHex = expectedDigest.toString('hex');
  if (expectedDigest.length !== SHA256_BYTES) {
    throw new FileSnapshotBlobError(`snapshot digest must be ${SHA256_BYTES} bytes`);
  }
  if (stored.codec !== FILE_SNAPSHOT_CODEC) {
    throw new FileSnapshotBlobError(`snapshot ${digestHex} has unsupported codec`);
  }
  if (!isValidByteCount(stored.rawBytes, MAX_STORED_RAW_BYTES)) {
    throw new FileSnapshotBlobError(`snapshot ${digestHex} has invalid raw byte count`);
  }
  if (!isValidByteCount(stored.compressedBytes, MAX_STORED_COMPRESSED_BYTES)) {
    throw new FileSnapshotBlobError(`snapshot ${digestHex} has invalid compressed byte count`);
  }
  if (!Buffer.isBuffer(stored.data) || stored.data.length !== stored.compressedBytes) {
    throw new FileSnapshotBlobError(`snapshot ${digestHex} has inconsistent compressed bytes`);
  }

  let raw: Buffer;
  try {
    raw = inflateRawSync(stored.data, { maxOutputLength: stored.rawBytes + 1 });
  } catch (err) {
    throw new FileSnapshotBlobError(
      `snapshot ${digestHex} could not be inflated: ${errorMessage(err)}`,
    );
  }
  if (raw.length !== stored.rawBytes) {
    throw new FileSnapshotBlobError(`snapshot ${digestHex} has inconsistent raw bytes`);
  }
  const actualDigest = createHash('sha256').update(raw).digest();
  if (!actualDigest.equals(expectedDigest)) {
    throw new FileSnapshotBlobError(`snapshot ${digestHex} failed digest verification`);
  }
  return raw;
}

function isValidByteCount(value: unknown, maximum: number): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0 && (value as number) <= maximum;
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
