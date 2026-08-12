import { isJsonObject, isJsonValue, type JsonObject } from './json';
import {
  parseSessionPresentationSummary,
  type SessionPresentationSummaryDto,
} from './session-presentation';

export const PENDING_INDEX_MAX_PAGE_SIZE = 50;
export const PENDING_INDEX_MAX_REQUESTS_PER_BUCKET = 256;
export const PENDING_INDEX_MAX_REQUESTS_PER_PAGE = 512;
const MAX_DISPLAY_BYTES = 65_536;
const TOKEN = /^[A-Za-z0-9][A-Za-z0-9._:@-]*$/;
const CONTROL = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/u;

export interface PendingIndexRequestDto {
  id: string;
  sessionId: string;
  kind: 'ask-user-question' | 'diff-review' | 'exit-plan' | 'permission';
  status: 'cancelled' | 'denied' | 'expired' | 'pending' | 'resolved' | 'stale';
  createdAt: number;
  expiresAt: number | null;
  display: JsonObject;
}

export interface PendingIndexBucketDto {
  session: SessionPresentationSummaryDto;
  requests: PendingIndexRequestDto[];
  revision: number;
}

export interface PendingIndexListParams {
  cursor?: string;
  limit: number;
}

export interface PendingIndexListResult {
  buckets: PendingIndexBucketDto[];
  nextCursor: string | null;
  totalBuckets: number;
  totalRequests: number;
  scanTruncated: boolean;
  revision: number;
}

function fail(field: string): never {
  throw new Error(`${field} is invalid`);
}

function exact(value: Record<string, unknown>, keys: readonly string[], field: string): void {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    fail(field);
  }
}

function integer(value: unknown, field: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) fail(field);
  return value as number;
}

function token(value: unknown, field: string, maximum = 256): string {
  if (
    typeof value !== 'string' || value.length === 0 ||
    new TextEncoder().encode(value).byteLength > maximum || CONTROL.test(value) ||
    !TOKEN.test(value)
  ) fail(field);
  return value;
}

function oneOf<T extends string>(value: unknown, allowed: readonly T[], field: string): T {
  if (typeof value !== 'string' || !allowed.includes(value as T)) fail(field);
  return value as T;
}

export function parsePendingIndexListParams(value: unknown): PendingIndexListParams {
  if (!isJsonObject(value)) fail('pending.index.list.params');
  const keys = value.cursor === undefined ? ['limit'] : ['cursor', 'limit'];
  exact(value, keys, 'pending.index.list.params');
  const limit = integer(value.limit, 'pending.index.list.limit');
  if (limit < 1 || limit > PENDING_INDEX_MAX_PAGE_SIZE) fail('pending.index.list.limit');
  return {
    limit,
    ...(value.cursor === undefined
      ? {}
      : { cursor: token(value.cursor, 'pending.index.list.cursor', 512) }),
  };
}

export function parsePendingIndexRequest(
  value: unknown,
  expectedSessionId?: string,
): PendingIndexRequestDto {
  if (!isJsonObject(value)) fail('pending.index.request');
  exact(value, [
    'createdAt', 'display', 'expiresAt', 'id', 'kind', 'sessionId', 'status',
  ], 'pending.index.request');
  if (!isJsonObject(value.display) || !isJsonValue(value.display) ||
      new TextEncoder().encode(JSON.stringify(value.display)).byteLength > MAX_DISPLAY_BYTES) {
    fail('pending.index.request.display');
  }
  const sessionId = token(value.sessionId, 'pending.index.request.sessionId');
  if (expectedSessionId !== undefined && sessionId !== expectedSessionId) {
    fail('pending.index.request.sessionId');
  }
  return {
    id: token(value.id, 'pending.index.request.id'),
    sessionId,
    kind: oneOf(value.kind,
      ['ask-user-question', 'diff-review', 'exit-plan', 'permission'],
      'pending.index.request.kind'),
    status: oneOf(value.status,
      ['cancelled', 'denied', 'expired', 'pending', 'resolved', 'stale'],
      'pending.index.request.status'),
    createdAt: integer(value.createdAt, 'pending.index.request.createdAt'),
    expiresAt: value.expiresAt === null
      ? null
      : integer(value.expiresAt, 'pending.index.request.expiresAt'),
    display: value.display,
  };
}

export function parsePendingIndexListResult(
  value: unknown,
  requestedLimit = PENDING_INDEX_MAX_PAGE_SIZE,
): PendingIndexListResult {
  if (!isJsonObject(value)) fail('pending.index.list.result');
  exact(value, [
    'buckets', 'nextCursor', 'revision', 'scanTruncated', 'totalBuckets', 'totalRequests',
  ], 'pending.index.list.result');
  const limit = integer(requestedLimit, 'pending.index.list.requestedLimit');
  if (limit < 1 || limit > PENDING_INDEX_MAX_PAGE_SIZE || !Array.isArray(value.buckets) ||
      value.buckets.length > limit || typeof value.scanTruncated !== 'boolean') {
    fail('pending.index.list.buckets');
  }
  let requestCount = 0;
  const buckets = value.buckets.map((bucket, index): PendingIndexBucketDto => {
    if (!isJsonObject(bucket)) fail(`pending.index.list.buckets.${index}`);
    exact(bucket, ['requests', 'revision', 'session'], `pending.index.list.buckets.${index}`);
    const session = parseSessionPresentationSummary(bucket.session);
    if (session.contextOnly || !Array.isArray(bucket.requests) ||
        bucket.requests.length > PENDING_INDEX_MAX_REQUESTS_PER_BUCKET) {
      fail(`pending.index.list.buckets.${index}`);
    }
    requestCount += bucket.requests.length;
    const requests = bucket.requests.map((request) =>
      parsePendingIndexRequest(request, session.id));
    if (new Set(requests.map((request) => request.id)).size !== requests.length) {
      fail(`pending.index.list.buckets.${index}.requests`);
    }
    return {
      session,
      requests,
      revision: integer(bucket.revision, `pending.index.list.buckets.${index}.revision`),
    };
  });
  if (requestCount > PENDING_INDEX_MAX_REQUESTS_PER_PAGE ||
      new Set(buckets.map((bucket) => bucket.session.id)).size !== buckets.length) {
    fail('pending.index.list.buckets');
  }
  const totalBuckets = integer(value.totalBuckets, 'pending.index.list.totalBuckets');
  const totalRequests = integer(value.totalRequests, 'pending.index.list.totalRequests');
  if (totalBuckets < buckets.length || totalRequests < requestCount) {
    fail('pending.index.list.totals');
  }
  return {
    buckets,
    nextCursor: value.nextCursor === null
      ? null
      : token(value.nextCursor, 'pending.index.list.nextCursor', 512),
    totalBuckets,
    totalRequests,
    scanTruncated: value.scanTruncated,
    revision: integer(value.revision, 'pending.index.list.revision'),
  };
}
