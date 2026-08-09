import { isJsonObject } from './json';
import {
  SessionConsoleContractError,
  parseWorkspaceDirectoryRef,
} from './session-console-common';
import {
  parseSessionConsoleCreateParams,
  type SessionConsoleCreateParams,
} from './session-console';

export const ISSUE_REMOTE_MAX_LIST_ITEMS = 100;
export const ISSUE_REMOTE_MAX_APPENDICES = 100;
export const ISSUE_REMOTE_MAX_KINDS = 32;
export const ISSUE_REMOTE_MAX_LABELS = 16;

export type IssueStatusDto = 'open' | 'in-progress' | 'resolved';
export type IssueSeverityDto = 'low' | 'medium' | 'high';

export interface IssueLogsRefDto {
  date: string;
  tsRange?: { start: number; end: number };
  scopes?: string[];
  note?: string;
}

export interface IssueAppendixDto {
  id: number;
  issueId: string;
  body: string;
  logsRef: IssueLogsRefDto | null;
  appendedSessionId: string | null;
  appendedAt: number;
}

export interface IssueDto {
  id: string;
  title: string;
  description: string;
  repro: string | null;
  kind: string;
  status: IssueStatusDto;
  severity: IssueSeverityDto;
  sourceSessionId: string | null;
  cwd: string | null;
  branchName: string | null;
  logsRef: IssueLogsRefDto | null;
  resolutionSessionId: string | null;
  labels: string[];
  createdAt: number;
  updatedAt: number;
  resolvedAt: number | null;
  deletedAt: number | null;
  appendices: IssueAppendixDto[];
  appendicesTruncated: boolean;
}

export interface IssueListParams {
  statuses: IssueStatusDto[];
  kinds: string[];
  titleKeyword: string | null;
  includeDeleted: boolean;
  limit: number;
  offset: number;
}

export interface IssueListResult {
  issues: IssueDto[];
  revision: number;
  truncated: boolean;
}

export interface IssueGetParams {
  issueId: string;
}

export interface IssueGetResult {
  issue: IssueDto | null;
  revision: number;
}

export interface IssueUpdatePatchDto {
  title?: string;
  description?: string;
  repro?: string | null;
  kind?: string;
  status?: IssueStatusDto;
  severity?: IssueSeverityDto;
  labels?: string[];
}

export interface IssueUpdateParams extends IssueGetParams {
  patch: IssueUpdatePatchDto;
}

export interface IssueMutationResult {
  issue: IssueDto;
  revision: number;
}

export interface IssueResolveInNewSessionParams {
  issueId: string;
  issueUpdatedAt: number;
  create: SessionConsoleCreateParams;
}

export interface IssueResolveInNewSessionResult extends IssueMutationResult {
  sessionId: string;
}

const CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f\u2028\u2029]/u;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const STATUSES: readonly IssueStatusDto[] = ['open', 'in-progress', 'resolved'];
const SEVERITIES: readonly IssueSeverityDto[] = ['low', 'medium', 'high'];
const PATCH_KEYS = [
  'description', 'kind', 'labels', 'repro', 'severity', 'status', 'title',
] as const;

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

function allowedKeys(value: Record<string, unknown>, allowed: readonly string[], field: string): void {
  const keys = Object.keys(value);
  if (keys.length === 0 || keys.some((key) => !allowed.includes(key))) fail(field);
}

function bytes(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

function text(value: unknown, field: string, maximum: number, empty = true): string {
  if (
    typeof value !== 'string' || (!empty && value.length === 0) ||
    CONTROL.test(value) || bytes(value) > maximum
  ) fail(field);
  return value;
}

function identifier(value: unknown, field: string): string {
  const result = text(value, field, 256, false);
  if (result.trim() !== result) fail(field);
  return result;
}

function integer(value: unknown, field: string, min = 0, max = Number.MAX_SAFE_INTEGER): number {
  if (!Number.isSafeInteger(value) || (value as number) < min || (value as number) > max) fail(field);
  return value as number;
}

function nullableInteger(value: unknown, field: string): number | null {
  return value === null ? null : integer(value, field);
}

function stringList(
  value: unknown,
  field: string,
  maximumItems: number,
  maximumBytes: number,
): string[] {
  if (!Array.isArray(value) || value.length > maximumItems) fail(field);
  return value.map((item, index) => text(item, `${field}[${index}]`, maximumBytes, false));
}

function enumValue<T extends string>(
  value: unknown,
  allowed: readonly T[],
  field: string,
): T {
  if (!allowed.includes(value as T)) fail(field);
  return value as T;
}

function logsRef(value: unknown, field: string): IssueLogsRefDto | null {
  if (value === null) return null;
  const raw = object(value, field);
  const keys = ['date'];
  if (raw.tsRange !== undefined) keys.push('tsRange');
  if (raw.scopes !== undefined) keys.push('scopes');
  if (raw.note !== undefined) keys.push('note');
  exactKeys(raw, keys, field);
  const date = text(raw.date, `${field}.date`, 10, false);
  if (!DATE.test(date)) fail(`${field}.date`);
  let tsRange: IssueLogsRefDto['tsRange'];
  if (raw.tsRange !== undefined) {
    const range = object(raw.tsRange, `${field}.tsRange`);
    exactKeys(range, ['end', 'start'], `${field}.tsRange`);
    const start = integer(range.start, `${field}.tsRange.start`);
    const end = integer(range.end, `${field}.tsRange.end`);
    if (start > end) fail(`${field}.tsRange`);
    tsRange = { start, end };
  }
  return {
    date,
    ...(tsRange ? { tsRange } : {}),
    ...(raw.scopes === undefined
      ? {}
      : { scopes: stringList(raw.scopes, `${field}.scopes`, 32, 256) }),
    ...(raw.note === undefined ? {} : { note: text(raw.note, `${field}.note`, 8 * 1024) }),
  };
}

function appendix(value: unknown, field: string, issueId: string): IssueAppendixDto {
  const raw = object(value, field);
  exactKeys(raw, ['appendedAt', 'appendedSessionId', 'body', 'id', 'issueId', 'logsRef'], field);
  const parsedIssueId = identifier(raw.issueId, `${field}.issueId`);
  if (parsedIssueId !== issueId) fail(`${field}.issueId`);
  return {
    id: integer(raw.id, `${field}.id`, 1),
    issueId: parsedIssueId,
    body: text(raw.body, `${field}.body`, 16 * 1024),
    logsRef: logsRef(raw.logsRef, `${field}.logsRef`),
    appendedSessionId: raw.appendedSessionId === null
      ? null
      : identifier(raw.appendedSessionId, `${field}.appendedSessionId`),
    appendedAt: integer(raw.appendedAt, `${field}.appendedAt`),
  };
}

function issue(value: unknown, field: string): IssueDto {
  const raw = object(value, field);
  exactKeys(raw, [
    'appendices', 'appendicesTruncated', 'branchName', 'createdAt', 'cwd', 'deletedAt',
    'description', 'id', 'kind', 'labels', 'logsRef', 'repro', 'resolutionSessionId',
    'resolvedAt', 'severity', 'sourceSessionId', 'status', 'title', 'updatedAt',
  ], field);
  const id = identifier(raw.id, `${field}.id`);
  if (!Array.isArray(raw.appendices) || raw.appendices.length > ISSUE_REMOTE_MAX_APPENDICES) {
    fail(`${field}.appendices`);
  }
  if (typeof raw.appendicesTruncated !== 'boolean') fail(`${field}.appendicesTruncated`);
  return {
    id,
    title: text(raw.title, `${field}.title`, 2 * 1024, false),
    description: text(raw.description, `${field}.description`, 16 * 1024, false),
    repro: raw.repro === null ? null : text(raw.repro, `${field}.repro`, 16 * 1024, false),
    kind: text(raw.kind, `${field}.kind`, 256, false),
    status: enumValue(raw.status, STATUSES, `${field}.status`),
    severity: enumValue(raw.severity, SEVERITIES, `${field}.severity`),
    sourceSessionId: raw.sourceSessionId === null
      ? null : identifier(raw.sourceSessionId, `${field}.sourceSessionId`),
    cwd: raw.cwd === null ? null : parseWorkspaceDirectoryRef(raw.cwd, `${field}.cwd`),
    branchName: raw.branchName === null
      ? null : text(raw.branchName, `${field}.branchName`, 2 * 1024, false),
    logsRef: logsRef(raw.logsRef, `${field}.logsRef`),
    resolutionSessionId: raw.resolutionSessionId === null
      ? null : identifier(raw.resolutionSessionId, `${field}.resolutionSessionId`),
    labels: stringList(raw.labels, `${field}.labels`, ISSUE_REMOTE_MAX_LABELS, 512),
    createdAt: integer(raw.createdAt, `${field}.createdAt`),
    updatedAt: integer(raw.updatedAt, `${field}.updatedAt`),
    resolvedAt: nullableInteger(raw.resolvedAt, `${field}.resolvedAt`),
    deletedAt: nullableInteger(raw.deletedAt, `${field}.deletedAt`),
    appendices: raw.appendices.map((item, index) => appendix(
      item, `${field}.appendices[${index}]`, id,
    )),
    appendicesTruncated: raw.appendicesTruncated,
  };
}

export function parseIssueListParams(value: unknown): IssueListParams {
  const raw = object(value, 'issues.list.params');
  exactKeys(raw, [
    'includeDeleted', 'kinds', 'limit', 'offset', 'statuses', 'titleKeyword',
  ], 'issues.list.params');
  if (typeof raw.includeDeleted !== 'boolean') fail('issues.list.includeDeleted');
  return {
    statuses: stringList(raw.statuses, 'issues.list.statuses', STATUSES.length, 32)
      .map((item) => enumValue(item, STATUSES, 'issues.list.statuses')),
    kinds: stringList(raw.kinds, 'issues.list.kinds', ISSUE_REMOTE_MAX_KINDS, 256),
    titleKeyword: raw.titleKeyword === null
      ? null : text(raw.titleKeyword, 'issues.list.titleKeyword', 1_024),
    includeDeleted: raw.includeDeleted,
    limit: integer(raw.limit, 'issues.list.limit', 1, ISSUE_REMOTE_MAX_LIST_ITEMS),
    offset: integer(raw.offset, 'issues.list.offset', 0, 1_000_000),
  };
}

export function parseIssueGetParams(value: unknown): IssueGetParams {
  const raw = object(value, 'issues.get.params');
  exactKeys(raw, ['issueId'], 'issues.get.params');
  return { issueId: identifier(raw.issueId, 'issues.get.issueId') };
}

export function parseIssueUpdatePatch(value: unknown): IssueUpdatePatchDto {
  const raw = object(value, 'issues.update.patch');
  allowedKeys(raw, PATCH_KEYS, 'issues.update.patch');
  return {
    ...(raw.title === undefined ? {} : { title: text(raw.title, 'issues.update.title', 2_048, false) }),
    ...(raw.description === undefined
      ? {} : { description: text(raw.description, 'issues.update.description', 16 * 1024, false) }),
    ...(raw.repro === undefined
      ? {} : { repro: raw.repro === null ? null : text(raw.repro, 'issues.update.repro', 16 * 1024, false) }),
    ...(raw.kind === undefined ? {} : { kind: text(raw.kind, 'issues.update.kind', 256, false) }),
    ...(raw.status === undefined
      ? {} : { status: enumValue(raw.status, STATUSES, 'issues.update.status') }),
    ...(raw.severity === undefined
      ? {} : { severity: enumValue(raw.severity, SEVERITIES, 'issues.update.severity') }),
    ...(raw.labels === undefined
      ? {} : { labels: stringList(raw.labels, 'issues.update.labels', ISSUE_REMOTE_MAX_LABELS, 512) }),
  };
}

export function parseIssueUpdateParams(value: unknown): IssueUpdateParams {
  const raw = object(value, 'issues.update.params');
  exactKeys(raw, ['issueId', 'patch'], 'issues.update.params');
  return {
    issueId: identifier(raw.issueId, 'issues.update.issueId'),
    patch: parseIssueUpdatePatch(raw.patch),
  };
}

export function parseIssueResolveInNewSessionParams(
  value: unknown,
): IssueResolveInNewSessionParams {
  const raw = object(value, 'issues.resolve-in-new-session.params');
  exactKeys(raw, ['create', 'issueId', 'issueUpdatedAt'], 'issues.resolve-in-new-session.params');
  return {
    issueId: identifier(raw.issueId, 'issues.resolve-in-new-session.issueId'),
    issueUpdatedAt: integer(
      raw.issueUpdatedAt,
      'issues.resolve-in-new-session.issueUpdatedAt',
    ),
    create: parseSessionConsoleCreateParams(raw.create),
  };
}

export function parseIssueListResult(value: unknown, limit: number): IssueListResult {
  const raw = object(value, 'issues.list.result');
  exactKeys(raw, ['issues', 'revision', 'truncated'], 'issues.list.result');
  if (!Array.isArray(raw.issues) || raw.issues.length > limit || typeof raw.truncated !== 'boolean') {
    fail('issues.list.issues');
  }
  const issues = raw.issues.map((item, index) => issue(item, `issues.list.issues[${index}]`));
  if (new Set(issues.map((item) => item.id)).size !== issues.length) fail('issues.list.issues');
  return { issues, revision: integer(raw.revision, 'issues.list.revision'), truncated: raw.truncated };
}

export function parseIssueGetResult(value: unknown, expectedIssueId?: string): IssueGetResult {
  const raw = object(value, 'issues.get.result');
  exactKeys(raw, ['issue', 'revision'], 'issues.get.result');
  const parsed = raw.issue === null ? null : issue(raw.issue, 'issues.get.issue');
  if (expectedIssueId !== undefined && parsed !== null && parsed.id !== expectedIssueId) {
    fail('issues.get.issue.id');
  }
  return {
    issue: parsed,
    revision: integer(raw.revision, 'issues.get.revision'),
  };
}

export function parseIssueMutationResult(value: unknown, expectedIssueId?: string): IssueMutationResult {
  const raw = object(value, 'issues.mutation.result');
  exactKeys(raw, ['issue', 'revision'], 'issues.mutation.result');
  const parsed = issue(raw.issue, 'issues.mutation.issue');
  if (expectedIssueId !== undefined && parsed.id !== expectedIssueId) {
    fail('issues.mutation.issue.id');
  }
  return {
    issue: parsed,
    revision: integer(raw.revision, 'issues.mutation.revision'),
  };
}

export function parseIssueResolveInNewSessionResult(
  value: unknown,
  expectedIssueId?: string,
): IssueResolveInNewSessionResult {
  const raw = object(value, 'issues.resolve-in-new-session.result');
  exactKeys(raw, ['issue', 'revision', 'sessionId'], 'issues.resolve-in-new-session.result');
  const parsedIssue = issue(raw.issue, 'issues.resolve-in-new-session.issue');
  const sessionId = identifier(raw.sessionId, 'issues.resolve-in-new-session.sessionId');
  if (expectedIssueId !== undefined && parsedIssue.id !== expectedIssueId) {
    fail('issues.resolve-in-new-session.issue.id');
  }
  if (parsedIssue.resolutionSessionId !== sessionId) {
    fail('issues.resolve-in-new-session.issue.resolutionSessionId');
  }
  return {
    issue: parsedIssue,
    revision: integer(raw.revision, 'issues.resolve-in-new-session.revision'),
    sessionId,
  };
}
