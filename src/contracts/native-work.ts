import { SessionConsoleContractError } from './session-console-common';
/** Native work belongs to one provider runtime, never to the universal team-task store. */
export type NativeWorkProvider = 'claude-code' | 'codex-cli' | 'grok-build';
export type NativeWorkStatus = 'pending' | 'running' | 'paused' | 'completed' | 'failed' | 'stopped' | 'unknown';
export interface NativeWorkRef {
  sessionId: string;
  provider: NativeWorkProvider;
  nativeId: string;
  runId: string;
  runtimeId: string;
}
export interface NativeWorkSnapshot {
  native: NativeWorkRef;
  taskId: string;
  runId: string;
  workKind: 'subagent' | 'shell';
  status: NativeWorkStatus;
  description: string;
  /** Host observation order of an authoritative new attempt; native IDs are opaque. */
  startedAt: number;
  updatedAt: number;
  runtimeStartedAt?: number;
  revision: number;
  parentTaskId?: string;
  toolUseId?: string;
  /** Hashed native tool ID for matching a child conversation's opaque detail records. */
  toolUseKey?: string;
  summary?: string;
  error?: string;
  lastToolName?: string;
  hidden?: boolean;
  detailStatus: 'available' | 'partial' | 'unavailable';
  canStop: boolean;
  controlReason?: string;
}
export type NativeWorkDetailKind = 'message' | 'thinking' | 'tool-use-start' | 'tool-use-end' | 'output' | 'file-changed';
/** Flat, bounded display records cannot carry parent lifecycle, context or billing events. */
export interface NativeWorkDetail {
  native: NativeWorkRef;
  recordId: string;
  recordRevision: number;
  kind: NativeWorkDetailKind;
  text: string;
  toolName?: string;
  role?: 'user' | 'assistant' | 'system';
  /** Opaque, owner-scoped tool identity; never inferred from adjacent records. */
  toolUseId?: string;
  toolStatus?: string;
  exitCode?: number;
  part: number;
  parts: number;
  ts: number;
  sourceTruncated: boolean;
}
export interface NativeWorkListParams { sessionId: string; history?: boolean; cursor?: number; limit?: number }
export interface NativeWorkListResult { tasks: NativeWorkSnapshot[]; revision: number; nextCursor: number | null }
export interface NativeWorkDetailParams { ref: NativeWorkRef; cursor?: number; limit?: number; order?: 'asc' | 'desc' }
export interface NativeWorkDetailResult {
  records: Array<NativeWorkDetail & { id: number }>;
  nextCursor: number | null;
  revision: number;
}
export type NativeWorkStopStatus = 'accepted' | 'already-terminal' | 'unsupported' | 'stale' | 'failed' | 'timed-out';
export interface NativeWorkStopResult { status: NativeWorkStopStatus; reason?: string }
export const NATIVE_WORK_TEXT_BYTES = 16 * 1024;
export const NATIVE_WORK_PAGE_SIZE = 16;

const providers = new Set(['claude-code', 'codex-cli', 'grok-build']);
const statuses = new Set(['pending', 'running', 'paused', 'completed', 'failed', 'stopped', 'unknown']);
const detailKinds = new Set(['message', 'thinking', 'tool-use-start', 'tool-use-end', 'output', 'file-changed']);
const bytes = (value: string) => new TextEncoder().encode(value).byteLength;
const object = (value: unknown): Record<string, unknown> | null => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null ? value as Record<string, unknown> : null;
};
const id = (value: unknown): value is string => typeof value === 'string' && value.length > 0 &&
  bytes(value) <= 512 && !/[\u0000-\u001f\u007f]/u.test(value);
const integer = (value: unknown): value is number => Number.isSafeInteger(value) && Number(value) >= 0;

export function readNativeWorkRef(value: unknown): NativeWorkRef | null {
  const row = object(value);
  if (!row || Object.keys(row).some(key => !['sessionId', 'provider', 'nativeId', 'runId', 'runtimeId'].includes(key)) || !providers.has(row.provider as string) ||
    !['sessionId', 'nativeId', 'runId', 'runtimeId'].every(key => id(row[key]))) return null;
  return { sessionId: row.sessionId as string, provider: row.provider as NativeWorkProvider,
    nativeId: row.nativeId as string, runId: row.runId as string, runtimeId: row.runtimeId as string };
}

export function readNativeWorkSnapshot(value: unknown): NativeWorkSnapshot | null {
  const row = object(value), native = readNativeWorkRef(row?.native);
  if (!row || !native || row.taskId !== native.nativeId || row.runId !== native.runId ||
    !['subagent', 'shell'].includes(row.workKind as string) || !statuses.has(row.status as string) ||
    typeof row.description !== 'string' || bytes(row.description) > 8192 ||
    !integer(row.startedAt) || !integer(row.updatedAt) || !integer(row.revision) ||
    typeof row.canStop !== 'boolean' || !['available', 'partial', 'unavailable'].includes(row.detailStatus as string)) return null;
  if (row.runtimeStartedAt !== undefined && !integer(row.runtimeStartedAt)) return null;
  const result: NativeWorkSnapshot = { native, taskId: native.nativeId, runId: native.runId,
    workKind: row.workKind as NativeWorkSnapshot['workKind'], status: row.status as NativeWorkStatus,
    description: row.description, startedAt: row.startedAt, updatedAt: row.updatedAt,
    revision: row.revision, canStop: row.canStop, detailStatus: row.detailStatus as NativeWorkSnapshot['detailStatus'] };
  if (row.runtimeStartedAt !== undefined) result.runtimeStartedAt = row.runtimeStartedAt as number;
  if (row.toolUseKey !== undefined) {
    if (!id(row.toolUseKey)) return null;
    result.toolUseKey = row.toolUseKey;
  }
  for (const key of ['parentTaskId', 'toolUseId', 'summary', 'error', 'lastToolName', 'controlReason'] as const) {
    if (row[key] !== undefined) {
      if (typeof row[key] !== 'string' || bytes(row[key]) > 8192) return null;
      result[key] = row[key];
    }
  }
  if (row.hidden === true) result.hidden = true;
  return result;
}

export function readNativeWorkDetail(value: unknown): NativeWorkDetail | null {
  const row = object(value), native = readNativeWorkRef(row?.native);
  if (!row || !native || !id(row.recordId) || !detailKinds.has(row.kind as string) ||
    !integer(row.recordRevision) || !integer(row.part) || !integer(row.parts) || row.parts < 1 ||
    row.part >= row.parts || row.parts > 65536 || !integer(row.ts) ||
    typeof row.text !== 'string' || bytes(row.text) > NATIVE_WORK_TEXT_BYTES ||
    typeof row.sourceTruncated !== 'boolean' ||
    (row.toolName !== undefined && !id(row.toolName)) ||
    (row.toolUseId !== undefined && !id(row.toolUseId)) ||
    (row.toolStatus !== undefined && !id(row.toolStatus)) ||
    (row.role !== undefined && (typeof row.role !== 'string' || !['user', 'assistant', 'system'].includes(row.role))) ||
    (row.exitCode !== undefined && !Number.isSafeInteger(row.exitCode))) return null;
  return { native, recordId: row.recordId, recordRevision: row.recordRevision,
    kind: row.kind as NativeWorkDetailKind, text: row.text, part: row.part, parts: row.parts,
    ts: row.ts, sourceTruncated: row.sourceTruncated,
    ...(row.toolName === undefined ? {} : { toolName: row.toolName as string }),
    ...(row.role === undefined ? {} : { role: row.role as NativeWorkDetail['role'] }),
    ...(row.toolUseId === undefined ? {} : { toolUseId: row.toolUseId as string }),
    ...(row.toolStatus === undefined ? {} : { toolStatus: row.toolStatus as string }),
    ...(row.exitCode === undefined ? {} : { exitCode: row.exitCode as number }) };
}

export function parseNativeWorkListParams(value: unknown): NativeWorkListParams {
  const row = object(value);
  if (!row || !id(row.sessionId) || Object.keys(row).some(key => !['sessionId', 'history', 'cursor', 'limit'].includes(key)) ||
    row.history !== undefined && typeof row.history !== 'boolean' || row.cursor !== undefined && !integer(row.cursor) ||
    row.limit !== undefined && (!integer(row.limit) || row.limit < 1 || row.limit > 100)) throw new SessionConsoleContractError('native-work.list');
  return { sessionId: row.sessionId, ...(row.history === undefined ? {} : { history: row.history as boolean }),
    ...(row.cursor === undefined ? {} : { cursor: row.cursor as number }), ...(row.limit === undefined ? {} : { limit: row.limit as number }) };
}
export function parseNativeWorkDetailParams(value: unknown): NativeWorkDetailParams {
  const row = object(value), ref = readNativeWorkRef(row?.ref);
  if (!row || !ref || Object.keys(row).some(key => !['ref', 'cursor', 'limit', 'order'].includes(key)) ||
    (row.order !== undefined && row.order !== 'asc' && row.order !== 'desc') ||
    (row.cursor !== undefined && !integer(row.cursor)) ||
    (row.limit !== undefined && (!integer(row.limit) || row.limit < 1 || row.limit > NATIVE_WORK_PAGE_SIZE))) throw new SessionConsoleContractError('native-work.details');
  return { ref, ...(row.cursor === undefined ? {} : { cursor: row.cursor as number }),
    ...(row.order === undefined ? {} : { order: row.order as 'asc' | 'desc' }),
    ...(row.limit === undefined ? {} : { limit: row.limit as number }) };
}

export function parseNativeWorkStopParams(value: unknown): { ref: NativeWorkRef } {
  const raw = object(value), ref = readNativeWorkRef(raw?.ref);
  if (!raw || !ref || Object.keys(raw).length !== 1) throw new SessionConsoleContractError('native-work.stop');
  return { ref };
}
export function parseNativeWorkListResult(value: unknown, sessionId: string): NativeWorkListResult {
  const raw = object(value);
  if (!raw || !Array.isArray(raw.tasks) || raw.tasks.length > 100 || !integer(raw.revision) ||
    raw.nextCursor !== null && !integer(raw.nextCursor)) throw new SessionConsoleContractError('native-work.list.result');
  const tasks = raw.tasks.map(readNativeWorkSnapshot);
  if (tasks.some(task => !task || task.native.sessionId !== sessionId)) throw new SessionConsoleContractError('native-work.list.owner');
  return { tasks: tasks as NativeWorkSnapshot[], revision: raw.revision, nextCursor: raw.nextCursor as number | null };
}
export function parseNativeWorkDetailResult(value: unknown, ref: NativeWorkRef): NativeWorkDetailResult {
  const raw = object(value);
  if (!raw || !Array.isArray(raw.records) || raw.records.length > NATIVE_WORK_PAGE_SIZE || !integer(raw.revision) ||
    raw.nextCursor !== null && !integer(raw.nextCursor)) throw new SessionConsoleContractError('native-work.details.result');
  const records = raw.records.map(value => {
    const item = object(value), detail = readNativeWorkDetail(item);
    if (!item || !integer(item.id) || !detail || detail.native.sessionId !== ref.sessionId ||
      detail.native.provider !== ref.provider || detail.native.nativeId !== ref.nativeId || detail.native.runId !== ref.runId) throw new SessionConsoleContractError('native-work.details.owner');
    return { ...detail, id: item.id };
  });
  return { records, revision: raw.revision, nextCursor: raw.nextCursor as number | null };
}
export function parseNativeWorkStopResult(value: unknown): NativeWorkStopResult {
  const raw = object(value);
  if (!raw || !['accepted', 'already-terminal', 'unsupported', 'stale', 'failed', 'timed-out'].includes(String(raw.status)) ||
    raw.reason !== undefined && (typeof raw.reason !== 'string' || bytes(raw.reason) > 8192)) throw new SessionConsoleContractError('native-work.stop.result');
  return { status: raw.status as NativeWorkStopStatus, ...(raw.reason === undefined ? {} : { reason: raw.reason as string }) };
}
