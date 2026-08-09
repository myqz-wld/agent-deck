import { isJsonObject } from './json';
import { SessionConsoleContractError } from './session-console-common';

export const SESSION_TASK_MAX_ITEMS = 200;
export const SESSION_TASK_MAX_RELATIONS = 128;
export const SESSION_TASK_MAX_LABELS = 64;

export type SessionTaskStatus = 'pending' | 'active' | 'completed' | 'blocked' | 'abandoned';

export interface SessionTaskDto {
  id: string;
  ownerSessionId: string;
  teamId: string | null;
  subject: string;
  description: string | null;
  status: SessionTaskStatus;
  activeForm: string | null;
  priority: number;
  blocks: string[];
  blockedBy: string[];
  labels: string[];
  createdAt: string;
  updatedAt: string;
}

export interface SessionTaskListParams {
  sessionId: string;
  limit: number;
}

export interface SessionTaskListResult {
  tasks: SessionTaskDto[];
  revision: number;
}

const TOKEN = /^[A-Za-z0-9][A-Za-z0-9._:@-]*$/;
const CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f\u2028\u2029]/u;

function fail(field: string): never {
  throw new SessionConsoleContractError(field);
}

function object(value: unknown, field: string): Record<string, unknown> {
  if (!isJsonObject(value)) fail(field);
  return value;
}

function exactKeys(value: Record<string, unknown>, expected: readonly string[], field: string): void {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index])) {
    fail(field);
  }
}

function bytes(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

function token(value: unknown, field: string, maximum = 256): string {
  if (
    typeof value !== 'string' || !TOKEN.test(value) || CONTROL.test(value) ||
    bytes(value) > maximum
  ) fail(field);
  return value;
}

function text(value: unknown, field: string, maximum: number, empty = true): string {
  if (
    typeof value !== 'string' || (!empty && value.length === 0) ||
    CONTROL.test(value) || bytes(value) > maximum
  ) fail(field);
  return value;
}

function integer(value: unknown, field: string, minimum = 0, maximum = Number.MAX_SAFE_INTEGER): number {
  if (!Number.isSafeInteger(value) || (value as number) < minimum || (value as number) > maximum) {
    fail(field);
  }
  return value as number;
}

function tokenList(
  value: unknown,
  field: string,
  maximumItems: number,
  maximumBytes = 256,
): string[] {
  if (!Array.isArray(value) || value.length > maximumItems) fail(field);
  return value.map((item, index) => token(item, `${field}[${index}]`, maximumBytes));
}

function timestamp(value: unknown, field: string): string {
  const parsed = text(value, field, 128, false);
  if (!Number.isFinite(Date.parse(parsed))) fail(field);
  return parsed;
}

export function parseSessionTaskListParams(value: unknown): SessionTaskListParams {
  const raw = object(value, 'session.tasks.list.params');
  exactKeys(raw, ['limit', 'sessionId'], 'session.tasks.list.params');
  return {
    sessionId: token(raw.sessionId, 'session.tasks.list.sessionId'),
    limit: integer(raw.limit, 'session.tasks.list.limit', 1, SESSION_TASK_MAX_ITEMS),
  };
}

function task(value: unknown, index: number): SessionTaskDto {
  const field = `session.tasks.list.tasks[${index}]`;
  const raw = object(value, field);
  exactKeys(raw, [
    'activeForm', 'blockedBy', 'blocks', 'createdAt', 'description', 'id', 'labels',
    'ownerSessionId', 'priority', 'status', 'subject', 'teamId', 'updatedAt',
  ], field);
  const statuses: readonly SessionTaskStatus[] = [
    'pending', 'active', 'completed', 'blocked', 'abandoned',
  ];
  if (!statuses.includes(raw.status as SessionTaskStatus)) fail(`${field}.status`);
  return {
    id: token(raw.id, `${field}.id`),
    ownerSessionId: token(raw.ownerSessionId, `${field}.ownerSessionId`),
    teamId: raw.teamId === null ? null : token(raw.teamId, `${field}.teamId`),
    subject: text(raw.subject, `${field}.subject`, 8 * 1024, false),
    description: raw.description === null
      ? null
      : text(raw.description, `${field}.description`, 32 * 1024),
    status: raw.status as SessionTaskStatus,
    activeForm: raw.activeForm === null
      ? null
      : text(raw.activeForm, `${field}.activeForm`, 8 * 1024),
    priority: integer(raw.priority, `${field}.priority`, 0, 10),
    blocks: tokenList(raw.blocks, `${field}.blocks`, SESSION_TASK_MAX_RELATIONS),
    blockedBy: tokenList(raw.blockedBy, `${field}.blockedBy`, SESSION_TASK_MAX_RELATIONS),
    labels: tokenList(raw.labels, `${field}.labels`, SESSION_TASK_MAX_LABELS, 512),
    createdAt: timestamp(raw.createdAt, `${field}.createdAt`),
    updatedAt: timestamp(raw.updatedAt, `${field}.updatedAt`),
  };
}

export function parseSessionTaskListResult(
  value: unknown,
  limit: number,
): SessionTaskListResult {
  const raw = object(value, 'session.tasks.list.result');
  exactKeys(raw, ['revision', 'tasks'], 'session.tasks.list.result');
  if (!Array.isArray(raw.tasks) || raw.tasks.length > limit) fail('session.tasks.list.tasks');
  const tasks = raw.tasks.map(task);
  if (new Set(tasks.map((item) => item.id)).size !== tasks.length) {
    fail('session.tasks.list.tasks');
  }
  return {
    tasks,
    revision: integer(raw.revision, 'session.tasks.list.revision'),
  };
}
