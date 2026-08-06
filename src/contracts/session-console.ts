import { isJsonObject, type JsonObject } from './json';

export const SESSION_CONSOLE_MAX_PAGE_SIZE = 100;
export const SESSION_CONSOLE_MAX_CURSOR_BYTES = 512;
export const SESSION_CONSOLE_MAX_IDENTIFIER_BYTES = 256;
export const SESSION_CONSOLE_MAX_ALIAS_BYTES = 128;
export const SESSION_CONSOLE_MAX_TITLE_BYTES = 512;
export const SESSION_CONSOLE_MAX_WORKING_DIRECTORY_BYTES = 1_024;
export const SESSION_CONSOLE_MAX_INITIAL_MESSAGE_BYTES = 65_536;

const SAFE_TOKEN = /^[A-Za-z0-9][A-Za-z0-9._:@-]*$/;
const CONTROL = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/;

export interface SessionConsoleSummaryDto {
  id: string;
  adapterId: string;
  title: string | null;
  status: string;
  createdAt: number;
  updatedAt: number;
}

export interface ProjectReferenceDto {
  projectId: string;
  projectRef: string;
  alias: string;
  title: string | null;
}

export interface SessionConsoleListParams {
  cursor?: string;
  limit: number;
  includeArchived?: boolean;
}

export interface SessionConsoleListResult {
  sessions: SessionConsoleSummaryDto[];
  nextCursor: string | null;
  total: number | null;
  revision: number;
}

export interface SessionConsoleGetResult {
  session: SessionConsoleSummaryDto | null;
  revision: number;
}

export interface ProjectListParams {
  cursor?: string;
  limit: number;
}

export interface ProjectListResult {
  projects: ProjectReferenceDto[];
  nextCursor: string | null;
  total: number | null;
  revision: number;
}

export interface ProjectResolveResult {
  project: ProjectReferenceDto | null;
  revision: number;
}

export interface SessionConsoleCreateParams {
  adapterId: string;
  initialMessage: string;
  workingDirectory: string;
  options: JsonObject;
}

export interface SessionConsoleCreateResult {
  sessionId: string;
  revision: number;
}

export class SessionConsoleContractError extends Error {
  constructor(readonly field: string) {
    super(`Invalid session-console contract field: ${field}`);
    this.name = 'SessionConsoleContractError';
  }
}

function fail(field: string): never {
  throw new SessionConsoleContractError(field);
}

function utf8Bytes(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

function exactKeys(
  value: Record<string, unknown>,
  expected: readonly string[],
  field: string,
): void {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index])) {
    fail(field);
  }
}

function token(value: unknown, field: string, maximumBytes: number): string {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    utf8Bytes(value) > maximumBytes ||
    !SAFE_TOKEN.test(value)
  ) {
    fail(field);
  }
  return value;
}

function text(value: unknown, field: string, maximumBytes: number): string {
  if (
    typeof value !== 'string' ||
    utf8Bytes(value) > maximumBytes ||
    CONTROL.test(value)
  ) {
    fail(field);
  }
  return value;
}

/** A host-private workspace reference: `.` or one normalized relative POSIX directory. */
export function parseWorkspaceDirectoryRef(
  value: unknown,
  field = 'workspaceDirectory',
): string {
  if (
    typeof value !== 'string' || value.length === 0 || value.trim() !== value ||
    utf8Bytes(value) > SESSION_CONSOLE_MAX_WORKING_DIRECTORY_BYTES ||
    CONTROL.test(value) || value.includes('\\') || value.startsWith('/') ||
    (value !== '.' && value.split('/').some((segment) =>
      segment.length === 0 || segment === '.' || segment === '..'))
  ) {
    fail(field);
  }
  return value;
}

/** A bounded first user message. New provider sessions cannot exist without an initial turn. */
export function parseSessionConsoleInitialMessage(
  value: unknown,
  field = 'initialMessage',
): string {
  if (
    typeof value !== 'string' || value.trim().length === 0 ||
    utf8Bytes(value) > SESSION_CONSOLE_MAX_INITIAL_MESSAGE_BYTES ||
    /[\u0000\u0001-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f\u2028\u2029]/u.test(value)
  ) {
    fail(field);
  }
  return value;
}

function revision(value: unknown, field: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) fail(field);
  return value as number;
}

function cursor(value: unknown, field: string): string | null {
  if (value === null) return null;
  return token(value, field, SESSION_CONSOLE_MAX_CURSOR_BYTES);
}

function pageLimit(value: unknown, field: string): number {
  if (
    !Number.isSafeInteger(value) ||
    (value as number) <= 0 ||
    (value as number) > SESSION_CONSOLE_MAX_PAGE_SIZE
  ) {
    fail(field);
  }
  return value as number;
}

function nullableTotal(value: unknown, minimum: number, field: string): number | null {
  if (value === null) return null;
  const total = revision(value, field);
  if (total < minimum) fail(field);
  return total;
}

export function parseSessionConsoleSummary(value: unknown): SessionConsoleSummaryDto {
  if (!isJsonObject(value)) fail('session');
  exactKeys(
    value,
    ['adapterId', 'createdAt', 'id', 'status', 'title', 'updatedAt'],
    'session',
  );
  return {
    id: token(value.id, 'session.id', SESSION_CONSOLE_MAX_IDENTIFIER_BYTES),
    adapterId: token(value.adapterId, 'session.adapterId', SESSION_CONSOLE_MAX_ALIAS_BYTES),
    title: value.title === null
      ? null
      : text(value.title, 'session.title', SESSION_CONSOLE_MAX_TITLE_BYTES),
    status: token(value.status, 'session.status', SESSION_CONSOLE_MAX_ALIAS_BYTES),
    createdAt: revision(value.createdAt, 'session.createdAt'),
    updatedAt: revision(value.updatedAt, 'session.updatedAt'),
  };
}

export function parseProjectReference(value: unknown): ProjectReferenceDto {
  if (!isJsonObject(value)) fail('project');
  exactKeys(value, ['alias', 'projectId', 'projectRef', 'title'], 'project');
  return {
    projectId: token(value.projectId, 'project.projectId', SESSION_CONSOLE_MAX_IDENTIFIER_BYTES),
    projectRef: parseWorkspaceDirectoryRef(value.projectRef, 'project.projectRef'),
    alias: token(value.alias, 'project.alias', SESSION_CONSOLE_MAX_ALIAS_BYTES),
    title: value.title === null
      ? null
      : text(value.title, 'project.title', SESSION_CONSOLE_MAX_TITLE_BYTES),
  };
}

export function parseSessionConsoleListParams(value: unknown): SessionConsoleListParams {
  if (!isJsonObject(value)) fail('session.console.list.params');
  const keys = ['limit'];
  if (value.cursor !== undefined) keys.push('cursor');
  if (value.includeArchived !== undefined) keys.push('includeArchived');
  exactKeys(value, keys, 'session.console.list.params');
  if (value.includeArchived !== undefined && typeof value.includeArchived !== 'boolean') {
    fail('session.console.list.includeArchived');
  }
  return {
    ...(value.cursor === undefined
      ? {}
      : { cursor: token(value.cursor, 'session.console.list.cursor', SESSION_CONSOLE_MAX_CURSOR_BYTES) }),
    limit: pageLimit(value.limit, 'session.console.list.limit'),
    ...(value.includeArchived === undefined ? {} : { includeArchived: value.includeArchived }),
  };
}

export function parseProjectListParams(value: unknown): ProjectListParams {
  if (!isJsonObject(value)) fail('project.list.params');
  const keys = value.cursor === undefined ? ['limit'] : ['cursor', 'limit'];
  exactKeys(value, keys, 'project.list.params');
  return {
    ...(value.cursor === undefined
      ? {}
      : { cursor: token(value.cursor, 'project.list.cursor', SESSION_CONSOLE_MAX_CURSOR_BYTES) }),
    limit: pageLimit(value.limit, 'project.list.limit'),
  };
}

export function parseSessionConsoleListResult(
  value: unknown,
  requestedLimit = SESSION_CONSOLE_MAX_PAGE_SIZE,
): SessionConsoleListResult {
  if (!isJsonObject(value)) fail('session.console.list.result');
  exactKeys(value, ['nextCursor', 'revision', 'sessions', 'total'], 'session.console.list.result');
  const limit = pageLimit(requestedLimit, 'session.console.list.requestedLimit');
  if (!Array.isArray(value.sessions) || value.sessions.length > limit) {
    fail('session.console.list.sessions');
  }
  const sessions = value.sessions.map(parseSessionConsoleSummary);
  if (new Set(sessions.map((item) => item.id)).size !== sessions.length) {
    fail('session.console.list.sessions');
  }
  return {
    sessions,
    nextCursor: cursor(value.nextCursor, 'session.console.list.nextCursor'),
    total: nullableTotal(value.total, sessions.length, 'session.console.list.total'),
    revision: revision(value.revision, 'session.console.list.revision'),
  };
}

export function parseProjectListResult(
  value: unknown,
  requestedLimit = SESSION_CONSOLE_MAX_PAGE_SIZE,
): ProjectListResult {
  if (!isJsonObject(value)) fail('project.list.result');
  exactKeys(value, ['nextCursor', 'projects', 'revision', 'total'], 'project.list.result');
  const limit = pageLimit(requestedLimit, 'project.list.requestedLimit');
  if (!Array.isArray(value.projects) || value.projects.length > limit) fail('project.list.projects');
  const projects = value.projects.map(parseProjectReference);
  for (const key of ['projectId', 'projectRef', 'alias'] as const) {
    if (new Set(projects.map((item) => item[key])).size !== projects.length) {
      fail(`project.list.${key}`);
    }
  }
  return {
    projects,
    nextCursor: cursor(value.nextCursor, 'project.list.nextCursor'),
    total: nullableTotal(value.total, projects.length, 'project.list.total'),
    revision: revision(value.revision, 'project.list.revision'),
  };
}

export function parseSessionConsoleGetResult(value: unknown): SessionConsoleGetResult {
  if (!isJsonObject(value)) fail('session.console.get.result');
  exactKeys(value, ['revision', 'session'], 'session.console.get.result');
  return {
    session: value.session === null ? null : parseSessionConsoleSummary(value.session),
    revision: revision(value.revision, 'session.console.get.revision'),
  };
}

export function parseProjectResolveResult(value: unknown): ProjectResolveResult {
  if (!isJsonObject(value)) fail('project.resolve.result');
  exactKeys(value, ['project', 'revision'], 'project.resolve.result');
  return {
    project: value.project === null ? null : parseProjectReference(value.project),
    revision: revision(value.revision, 'project.resolve.revision'),
  };
}

export function parseSessionConsoleCreateParams(value: unknown): SessionConsoleCreateParams {
  if (!isJsonObject(value)) fail('session.console.create.params');
  exactKeys(
    value,
    ['adapterId', 'initialMessage', 'options', 'workingDirectory'],
    'session.console.create.params',
  );
  if (!isJsonObject(value.options)) fail('session.console.create.options');
  return {
    adapterId: token(value.adapterId, 'session.console.create.adapterId', SESSION_CONSOLE_MAX_ALIAS_BYTES),
    initialMessage: parseSessionConsoleInitialMessage(
      value.initialMessage,
      'session.console.create.initialMessage',
    ),
    workingDirectory: parseWorkspaceDirectoryRef(
      value.workingDirectory,
      'session.console.create.workingDirectory',
    ),
    options: value.options,
  };
}

export function parseSessionConsoleCreateResult(value: unknown): SessionConsoleCreateResult {
  if (!isJsonObject(value)) fail('session.console.create.result');
  exactKeys(value, ['revision', 'sessionId'], 'session.console.create.result');
  return {
    sessionId: token(value.sessionId, 'session.console.create.sessionId', SESSION_CONSOLE_MAX_IDENTIFIER_BYTES),
    revision: revision(value.revision, 'session.console.create.revision'),
  };
}

export function parseSessionConsoleGetParams(value: unknown): { sessionId: string } {
  if (!isJsonObject(value)) fail('session.console.get.params');
  exactKeys(value, ['sessionId'], 'session.console.get.params');
  return {
    sessionId: token(value.sessionId, 'session.console.get.sessionId', SESSION_CONSOLE_MAX_IDENTIFIER_BYTES),
  };
}

export function parseProjectResolveParams(value: unknown): { alias: string } {
  if (!isJsonObject(value)) fail('project.resolve.params');
  exactKeys(value, ['alias'], 'project.resolve.params');
  return {
    alias: token(value.alias, 'project.resolve.alias', SESSION_CONSOLE_MAX_ALIAS_BYTES),
  };
}
