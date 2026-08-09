import { isJsonObject, type JsonObject } from './json';
import { SessionConsoleContractError } from './session-console-common';

export const SESSION_DETAIL_MAX_SUMMARIES = 50;
export const SESSION_DETAIL_MAX_FILE_CHANGES = 100;
export const SESSION_DETAIL_MAX_SUMMARY_BYTES = 32 * 1024;
export const SESSION_DETAIL_MAX_FILE_CONTENT_BYTES = 1024 * 1024;
export const SESSION_DETAIL_MAX_METADATA_BYTES = 256 * 1024;
export const SESSION_DETAIL_MAX_FINAL_DIFF_BYTES = 3 * 1024 * 1024;

export interface SessionSummaryDto {
  id: number;
  sessionId: string;
  content: string;
  trigger: 'time' | 'event-count' | 'manual';
  ts: number;
  sourceEventRevision: number;
  sourceRebuildAfterRevision: number;
  generationSource: 'llm' | 'assistant-fallback' | 'stats-fallback';
}

export interface SessionSummaryListParams {
  sessionId: string;
  limit: number;
}

export interface SessionSummaryListResult {
  summaries: SessionSummaryDto[];
  revision: number;
}

export interface SessionFileChangeSummaryDto {
  id: number;
  sessionId: string;
  filePath: string;
  kind: string;
  toolCallId: string | null;
  hasBeforeBlob: boolean;
  hasAfterBlob: boolean;
  hasBeforeSnapshot: boolean;
  hasAfterSnapshot: boolean;
  ts: number;
}

export interface SessionFileChangeListParams {
  sessionId: string;
  cursor?: string;
  limit: number;
}

export interface SessionFileChangeListResult {
  items: SessionFileChangeSummaryDto[];
  nextCursor: string | null;
  revision: number;
}

export interface SessionFileChangePayloadDto {
  id: number;
  sessionId: string;
  filePath: string;
  kind: string;
  beforeBlob: string | null;
  afterBlob: string | null;
  beforeSnapshot: string | null;
  afterSnapshot: string | null;
  metadata: JsonObject;
  toolCallId: string | null;
  ts: number;
}

export interface SessionFileChangeGetParams {
  sessionId: string;
  changeId: number;
}

export interface SessionFileChangeGetResult {
  change: SessionFileChangePayloadDto | null;
  revision: number;
}

export type SessionFileFinalDiffReason =
  | 'not_in_session'
  | 'unchanged'
  | 'too_large'
  | 'snapshot_unavailable';

export interface SessionFileFinalDiffDto {
  ok: boolean;
  filePath: string;
  diff: string | null;
  source: 'recorded-snapshot' | 'recorded-patch-fallback';
  reason?: SessionFileFinalDiffReason;
  message?: string;
}

export interface SessionFileFinalDiffParams {
  sessionId: string;
  filePath: string;
}

export interface SessionFileFinalDiffResult {
  fileDiff: SessionFileFinalDiffDto;
  revision: number;
}

const TOKEN = /^[A-Za-z0-9][A-Za-z0-9._:@-]*$/;
const CURSOR = /^[A-Za-z0-9_-]+$/;
const CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f\u2028\u2029]/u;

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

function bytes(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

function token(value: unknown, field: string, maxBytes = 256): string {
  if (
    typeof value !== 'string' || !TOKEN.test(value) || CONTROL.test(value) ||
    bytes(value) > maxBytes
  ) fail(field);
  return value;
}

function text(value: unknown, field: string, maxBytes: number): string {
  if (typeof value !== 'string' || CONTROL.test(value) || bytes(value) > maxBytes) fail(field);
  return value;
}

function integer(value: unknown, field: string, minimum = 0): number {
  if (!Number.isSafeInteger(value) || (value as number) < minimum) fail(field);
  return value as number;
}

function boolean(value: unknown, field: string): boolean {
  if (typeof value !== 'boolean') fail(field);
  return value;
}

function relativeFilePath(value: unknown, field: string): string {
  if (
    typeof value !== 'string' || !value || value.trim() !== value ||
    value.startsWith('/') || value.includes('\\') || CONTROL.test(value) ||
    bytes(value) > 4_096 || value.split('/').some((part) => !part || part === '.' || part === '..')
  ) fail(field);
  return value;
}

function cursor(value: unknown, field: string): string {
  if (typeof value !== 'string' || !CURSOR.test(value) || bytes(value) > 1_024) fail(field);
  return value;
}

function nullableText(value: unknown, field: string, maxBytes: number): string | null {
  return value === null ? null : text(value, field, maxBytes);
}

function revision(value: unknown, field: string): number {
  return integer(value, field);
}

function listParams(
  value: unknown,
  field: string,
  maximum: number,
): { raw: Record<string, unknown>; sessionId: string; limit: number } {
  const raw = object(value, `${field}.params`);
  const limit = integer(raw.limit, `${field}.limit`, 1);
  if (limit > maximum) fail(`${field}.limit`);
  return { raw, sessionId: token(raw.sessionId, `${field}.sessionId`), limit };
}

export function parseSessionSummaryListParams(value: unknown): SessionSummaryListParams {
  const parsed = listParams(value, 'session.summaries.list', SESSION_DETAIL_MAX_SUMMARIES);
  exactKeys(parsed.raw, ['limit', 'sessionId'], 'session.summaries.list.params');
  return { sessionId: parsed.sessionId, limit: parsed.limit };
}

function summary(value: unknown, sessionId: string, index: number): SessionSummaryDto {
  const field = `session.summaries.list.summaries[${index}]`;
  const raw = object(value, field);
  exactKeys(raw, [
    'content', 'generationSource', 'id', 'sessionId', 'sourceEventRevision',
    'sourceRebuildAfterRevision', 'trigger', 'ts',
  ], field);
  if (!['time', 'event-count', 'manual'].includes(String(raw.trigger))) fail(`${field}.trigger`);
  if (!['llm', 'assistant-fallback', 'stats-fallback'].includes(String(raw.generationSource))) {
    fail(`${field}.generationSource`);
  }
  const parsedSessionId = token(raw.sessionId, `${field}.sessionId`);
  if (parsedSessionId !== sessionId) fail(`${field}.sessionId`);
  return {
    id: integer(raw.id, `${field}.id`, 1),
    sessionId: parsedSessionId,
    content: text(raw.content, `${field}.content`, SESSION_DETAIL_MAX_SUMMARY_BYTES),
    trigger: raw.trigger as SessionSummaryDto['trigger'],
    ts: integer(raw.ts, `${field}.ts`),
    sourceEventRevision: integer(raw.sourceEventRevision, `${field}.sourceEventRevision`),
    sourceRebuildAfterRevision: integer(
      raw.sourceRebuildAfterRevision,
      `${field}.sourceRebuildAfterRevision`,
    ),
    generationSource: raw.generationSource as SessionSummaryDto['generationSource'],
  };
}

export function parseSessionSummaryListResult(
  value: unknown,
  sessionId: string,
  limit: number,
): SessionSummaryListResult {
  const raw = object(value, 'session.summaries.list.result');
  exactKeys(raw, ['revision', 'summaries'], 'session.summaries.list.result');
  if (!Array.isArray(raw.summaries) || raw.summaries.length > limit) {
    fail('session.summaries.list.summaries');
  }
  const summaries = raw.summaries.map((item, index) => summary(item, sessionId, index));
  if (new Set(summaries.map((item) => item.id)).size !== summaries.length) {
    fail('session.summaries.list.summaries');
  }
  return { summaries, revision: revision(raw.revision, 'session.summaries.list.revision') };
}

export function parseSessionFileChangeListParams(value: unknown): SessionFileChangeListParams {
  const parsed = listParams(value, 'session.file-changes.list', SESSION_DETAIL_MAX_FILE_CHANGES);
  const expected = ['limit', 'sessionId'];
  if (parsed.raw.cursor !== undefined) expected.push('cursor');
  exactKeys(parsed.raw, expected, 'session.file-changes.list.params');
  return {
    sessionId: parsed.sessionId,
    ...(parsed.raw.cursor === undefined
      ? {}
      : { cursor: cursor(parsed.raw.cursor, 'session.file-changes.list.cursor') }),
    limit: parsed.limit,
  };
}

function fileChangeSummary(
  value: unknown,
  sessionId: string,
  index: number,
): SessionFileChangeSummaryDto {
  const field = `session.file-changes.list.items[${index}]`;
  const raw = object(value, field);
  exactKeys(raw, [
    'filePath', 'hasAfterBlob', 'hasAfterSnapshot', 'hasBeforeBlob',
    'hasBeforeSnapshot', 'id', 'kind', 'sessionId', 'toolCallId', 'ts',
  ], field);
  const parsedSessionId = token(raw.sessionId, `${field}.sessionId`);
  if (parsedSessionId !== sessionId) fail(`${field}.sessionId`);
  return {
    id: integer(raw.id, `${field}.id`, 1),
    sessionId: parsedSessionId,
    filePath: relativeFilePath(raw.filePath, `${field}.filePath`),
    kind: token(raw.kind, `${field}.kind`, 64),
    toolCallId: raw.toolCallId === null ? null : token(raw.toolCallId, `${field}.toolCallId`),
    hasBeforeBlob: boolean(raw.hasBeforeBlob, `${field}.hasBeforeBlob`),
    hasAfterBlob: boolean(raw.hasAfterBlob, `${field}.hasAfterBlob`),
    hasBeforeSnapshot: boolean(raw.hasBeforeSnapshot, `${field}.hasBeforeSnapshot`),
    hasAfterSnapshot: boolean(raw.hasAfterSnapshot, `${field}.hasAfterSnapshot`),
    ts: integer(raw.ts, `${field}.ts`),
  };
}

export function parseSessionFileChangeListResult(
  value: unknown,
  sessionId: string,
  limit: number,
): SessionFileChangeListResult {
  const raw = object(value, 'session.file-changes.list.result');
  exactKeys(raw, ['items', 'nextCursor', 'revision'], 'session.file-changes.list.result');
  if (!Array.isArray(raw.items) || raw.items.length > limit) fail('session.file-changes.list.items');
  const items = raw.items.map((item, index) => fileChangeSummary(item, sessionId, index));
  if (new Set(items.map((item) => item.id)).size !== items.length) {
    fail('session.file-changes.list.items');
  }
  return {
    items,
    nextCursor: raw.nextCursor === null
      ? null
      : cursor(raw.nextCursor, 'session.file-changes.list.nextCursor'),
    revision: revision(raw.revision, 'session.file-changes.list.revision'),
  };
}

export function parseSessionFileChangeGetParams(value: unknown): SessionFileChangeGetParams {
  const raw = object(value, 'session.file-changes.get.params');
  exactKeys(raw, ['changeId', 'sessionId'], 'session.file-changes.get.params');
  return {
    sessionId: token(raw.sessionId, 'session.file-changes.get.sessionId'),
    changeId: integer(raw.changeId, 'session.file-changes.get.changeId', 1),
  };
}

function fileChangePayload(
  value: unknown,
  sessionId: string,
  changeId: number,
): SessionFileChangePayloadDto {
  const field = 'session.file-changes.get.change';
  const raw = object(value, field);
  exactKeys(raw, [
    'afterBlob', 'afterSnapshot', 'beforeBlob', 'beforeSnapshot', 'filePath', 'id',
    'kind', 'metadata', 'sessionId', 'toolCallId', 'ts',
  ], field);
  const parsedSessionId = token(raw.sessionId, `${field}.sessionId`);
  if (parsedSessionId !== sessionId) fail(`${field}.sessionId`);
  const metadata = object(raw.metadata, `${field}.metadata`) as JsonObject;
  if (bytes(JSON.stringify(metadata)) > SESSION_DETAIL_MAX_METADATA_BYTES) fail(`${field}.metadata`);
  const id = integer(raw.id, `${field}.id`, 1);
  if (id !== changeId) fail(`${field}.id`);
  return {
    id,
    sessionId: parsedSessionId,
    filePath: relativeFilePath(raw.filePath, `${field}.filePath`),
    kind: token(raw.kind, `${field}.kind`, 64),
    beforeBlob: nullableText(
      raw.beforeBlob,
      `${field}.beforeBlob`,
      SESSION_DETAIL_MAX_FILE_CONTENT_BYTES,
    ),
    afterBlob: nullableText(
      raw.afterBlob,
      `${field}.afterBlob`,
      SESSION_DETAIL_MAX_FILE_CONTENT_BYTES,
    ),
    beforeSnapshot: nullableText(
      raw.beforeSnapshot,
      `${field}.beforeSnapshot`,
      SESSION_DETAIL_MAX_FILE_CONTENT_BYTES,
    ),
    afterSnapshot: nullableText(
      raw.afterSnapshot,
      `${field}.afterSnapshot`,
      SESSION_DETAIL_MAX_FILE_CONTENT_BYTES,
    ),
    metadata,
    toolCallId: raw.toolCallId === null ? null : token(raw.toolCallId, `${field}.toolCallId`),
    ts: integer(raw.ts, `${field}.ts`),
  };
}

export function parseSessionFileChangeGetResult(
  value: unknown,
  sessionId: string,
  changeId: number,
): SessionFileChangeGetResult {
  const raw = object(value, 'session.file-changes.get.result');
  exactKeys(raw, ['change', 'revision'], 'session.file-changes.get.result');
  return {
    change: raw.change === null ? null : fileChangePayload(raw.change, sessionId, changeId),
    revision: revision(raw.revision, 'session.file-changes.get.revision'),
  };
}

export function parseSessionFileFinalDiffParams(value: unknown): SessionFileFinalDiffParams {
  const raw = object(value, 'session.file-changes.final-diff.params');
  exactKeys(raw, ['filePath', 'sessionId'], 'session.file-changes.final-diff.params');
  return {
    sessionId: token(raw.sessionId, 'session.file-changes.final-diff.sessionId'),
    filePath: relativeFilePath(raw.filePath, 'session.file-changes.final-diff.filePath'),
  };
}

function fileFinalDiff(value: unknown, requestedPath: string): SessionFileFinalDiffDto {
  const field = 'session.file-changes.final-diff.fileDiff';
  const raw = object(value, field);
  const expected = ['diff', 'filePath', 'ok', 'source'];
  if (raw.reason !== undefined) expected.push('reason');
  if (raw.message !== undefined) expected.push('message');
  exactKeys(raw, expected, field);
  const filePath = relativeFilePath(raw.filePath, `${field}.filePath`);
  if (filePath !== requestedPath) fail(`${field}.filePath`);
  if (!['recorded-snapshot', 'recorded-patch-fallback'].includes(String(raw.source))) {
    fail(`${field}.source`);
  }
  const reasons: SessionFileFinalDiffReason[] = [
    'not_in_session', 'unchanged', 'too_large', 'snapshot_unavailable',
  ];
  if (raw.reason !== undefined && !reasons.includes(raw.reason as SessionFileFinalDiffReason)) {
    fail(`${field}.reason`);
  }
  return {
    ok: boolean(raw.ok, `${field}.ok`),
    filePath,
    diff: nullableText(raw.diff, `${field}.diff`, SESSION_DETAIL_MAX_FINAL_DIFF_BYTES),
    source: raw.source as SessionFileFinalDiffDto['source'],
    ...(raw.reason === undefined ? {} : { reason: raw.reason as SessionFileFinalDiffReason }),
    ...(raw.message === undefined
      ? {}
      : { message: text(raw.message, `${field}.message`, 4_096) }),
  };
}

export function parseSessionFileFinalDiffResult(
  value: unknown,
  requestedPath: string,
): SessionFileFinalDiffResult {
  const raw = object(value, 'session.file-changes.final-diff.result');
  exactKeys(raw, ['fileDiff', 'revision'], 'session.file-changes.final-diff.result');
  return {
    fileDiff: fileFinalDiff(raw.fileDiff, requestedPath),
    revision: revision(raw.revision, 'session.file-changes.final-diff.revision'),
  };
}
