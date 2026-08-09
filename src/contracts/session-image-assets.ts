import { isJsonObject } from './json';
import { SessionConsoleContractError } from './session-console-common';

export const SESSION_IMAGE_ASSET_CHUNK_BYTES = 512 * 1024;
export const SESSION_IMAGE_ASSET_MAX_BYTES = 16 * 1024 * 1024;

export type SessionImageAssetSide = 'before' | 'after';
export type SessionImageAssetFailureReason =
  | 'changed'
  | 'denied'
  | 'enoent'
  | 'invalid_ext'
  | 'io_error'
  | 'too_big'
  | 'unsupported_source';

export interface SessionImageAssetReadParams {
  sessionId: string;
  changeId: number;
  side: SessionImageAssetSide;
  offset: number;
  expectedAssetId?: string;
}

export type SessionImageAssetReadResult =
  | { ok: false; reason: SessionImageAssetFailureReason; revision: number }
  | {
      ok: true;
      assetId: string;
      base64: string;
      bytes: number;
      changeId: number;
      mime: 'image/gif' | 'image/jpeg' | 'image/png' | 'image/webp';
      nextOffset: number | null;
      offset: number;
      revision: number;
      sessionId: string;
      side: SessionImageAssetSide;
      totalBytes: number;
    };

const TOKEN = /^[A-Za-z0-9][A-Za-z0-9._:@-]*$/;
const ASSET_ID = /^[A-Za-z0-9_-]{43}$/;
const BASE64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;

function fail(field: string): never {
  throw new SessionConsoleContractError(field);
}

function exactKeys(value: Record<string, unknown>, expected: readonly string[], field: string): void {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index])) {
    fail(field);
  }
}

function object(value: unknown, field: string): Record<string, unknown> {
  if (!isJsonObject(value)) fail(field);
  return value;
}

function integer(value: unknown, field: string, minimum = 0): number {
  if (!Number.isSafeInteger(value) || (value as number) < minimum) fail(field);
  return value as number;
}

function token(value: unknown, field: string): string {
  if (typeof value !== 'string' || !TOKEN.test(value) || value.length > 256) fail(field);
  return value;
}

function assetId(value: unknown, field: string): string {
  if (typeof value !== 'string' || !ASSET_ID.test(value)) fail(field);
  return value;
}

export function parseSessionImageAssetReadParams(value: unknown): SessionImageAssetReadParams {
  const raw = object(value, 'session.assets.image-chunk.read.params');
  const expected = ['changeId', 'offset', 'sessionId', 'side'];
  if (raw.expectedAssetId !== undefined) expected.push('expectedAssetId');
  exactKeys(raw, expected, 'session.assets.image-chunk.read.params');
  const offset = integer(raw.offset, 'session.assets.image-chunk.read.offset');
  if (offset > SESSION_IMAGE_ASSET_MAX_BYTES || offset % SESSION_IMAGE_ASSET_CHUNK_BYTES !== 0) {
    fail('session.assets.image-chunk.read.offset');
  }
  if ((offset === 0) !== (raw.expectedAssetId === undefined)) {
    fail('session.assets.image-chunk.read.expectedAssetId');
  }
  if (raw.side !== 'before' && raw.side !== 'after') {
    fail('session.assets.image-chunk.read.side');
  }
  return {
    sessionId: token(raw.sessionId, 'session.assets.image-chunk.read.sessionId'),
    changeId: integer(raw.changeId, 'session.assets.image-chunk.read.changeId', 1),
    side: raw.side,
    offset,
    ...(raw.expectedAssetId === undefined
      ? {}
      : { expectedAssetId: assetId(
          raw.expectedAssetId,
          'session.assets.image-chunk.read.expectedAssetId',
        ) }),
  };
}

function decodedBase64Bytes(value: string): number {
  const padding = value.endsWith('==') ? 2 : value.endsWith('=') ? 1 : 0;
  return (value.length / 4) * 3 - padding;
}

export function parseSessionImageAssetReadResult(
  value: unknown,
  expectedSource?: Pick<SessionImageAssetReadParams, 'changeId' | 'sessionId' | 'side'>,
): SessionImageAssetReadResult {
  const raw = object(value, 'session.assets.image-chunk.read.result');
  if (raw.ok === false) {
    exactKeys(raw, ['ok', 'reason', 'revision'], 'session.assets.image-chunk.read.result');
    const reasons: SessionImageAssetFailureReason[] = [
      'changed', 'denied', 'enoent', 'invalid_ext', 'io_error', 'too_big',
      'unsupported_source',
    ];
    if (!reasons.includes(raw.reason as SessionImageAssetFailureReason)) {
      fail('session.assets.image-chunk.read.reason');
    }
    return {
      ok: false,
      reason: raw.reason as SessionImageAssetFailureReason,
      revision: integer(raw.revision, 'session.assets.image-chunk.read.revision'),
    };
  }
  if (raw.ok !== true) fail('session.assets.image-chunk.read.ok');
  exactKeys(raw, [
    'assetId', 'base64', 'bytes', 'changeId', 'mime', 'nextOffset', 'offset', 'ok',
    'revision', 'sessionId', 'side', 'totalBytes',
  ], 'session.assets.image-chunk.read.result');
  const sessionId = token(raw.sessionId, 'session.assets.image-chunk.read.sessionId');
  const changeId = integer(raw.changeId, 'session.assets.image-chunk.read.changeId', 1);
  if (raw.side !== 'before' && raw.side !== 'after') {
    fail('session.assets.image-chunk.read.side');
  }
  const side = raw.side;
  if (expectedSource && (
    sessionId !== expectedSource.sessionId || changeId !== expectedSource.changeId ||
    side !== expectedSource.side
  )) fail('session.assets.image-chunk.read.source');
  const offset = integer(raw.offset, 'session.assets.image-chunk.read.offset');
  const bytes = integer(raw.bytes, 'session.assets.image-chunk.read.bytes', 1);
  const totalBytes = integer(raw.totalBytes, 'session.assets.image-chunk.read.totalBytes', 1);
  if (
    offset % SESSION_IMAGE_ASSET_CHUNK_BYTES !== 0 ||
    bytes > SESSION_IMAGE_ASSET_CHUNK_BYTES ||
    totalBytes > SESSION_IMAGE_ASSET_MAX_BYTES ||
    offset + bytes > totalBytes
  ) fail('session.assets.image-chunk.read.bounds');
  if (typeof raw.base64 !== 'string' || !BASE64.test(raw.base64) ||
      decodedBase64Bytes(raw.base64) !== bytes) {
    fail('session.assets.image-chunk.read.base64');
  }
  const nextOffset = raw.nextOffset === null
    ? null
    : integer(raw.nextOffset, 'session.assets.image-chunk.read.nextOffset', 1);
  const expectedNext = offset + bytes === totalBytes ? null : offset + bytes;
  if (nextOffset !== expectedNext || (nextOffset !== null &&
      nextOffset % SESSION_IMAGE_ASSET_CHUNK_BYTES !== 0)) {
    fail('session.assets.image-chunk.read.nextOffset');
  }
  const mimes = ['image/gif', 'image/jpeg', 'image/png', 'image/webp'] as const;
  if (!mimes.includes(raw.mime as (typeof mimes)[number])) {
    fail('session.assets.image-chunk.read.mime');
  }
  return {
    ok: true,
    assetId: assetId(raw.assetId, 'session.assets.image-chunk.read.assetId'),
    base64: raw.base64,
    bytes,
    changeId,
    mime: raw.mime as (typeof mimes)[number],
    nextOffset,
    offset,
    revision: integer(raw.revision, 'session.assets.image-chunk.read.revision'),
    sessionId,
    side,
    totalBytes,
  };
}
