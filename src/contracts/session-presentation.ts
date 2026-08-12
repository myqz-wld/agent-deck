import { isJsonObject } from './json';

export const SESSION_PRESENTATION_MAX_PAGE_SIZE = 100;
export const SESSION_PRESENTATION_MAX_CONTEXT_ROWS = 200;
export const SESSION_PRESENTATION_MAX_TEAMS = 16;
export const SESSION_PRESENTATION_MAX_QUERY_BYTES = 512;
export const SESSION_PRESENTATION_MAX_TEXT_BYTES = 2_048;

const TOKEN = /^[A-Za-z0-9][A-Za-z0-9._:@-]*$/;
const CONTROL = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/u;

export type SessionPresentationKind = 'history' | 'live';
export type SessionPresentationSource = 'cli' | 'sdk';
export type SessionPresentationLifecycle = 'active' | 'closed' | 'dormant';
export type SessionPresentationActivity = 'finished' | 'idle' | 'waiting' | 'working';

export interface SessionPresentationTeamDto {
  teamId: string;
  teamName: string;
  role: 'lead' | 'teammate';
  joinedAt: number;
}

export interface SessionPresentationContextDto {
  usedTokens: number | null;
  windowTokens: number | null;
}

export interface SessionPresentationSummaryDto {
  id: string;
  adapterId: string;
  title: string;
  source: SessionPresentationSource;
  lifecycle: SessionPresentationLifecycle;
  activity: SessionPresentationActivity;
  archived: boolean;
  pinned: boolean;
  createdAt: number;
  updatedAt: number;
  endedAt: number | null;
  model: string | null;
  thinking: string | null;
  runtimeProvider: string | null;
  context: SessionPresentationContextDto | null;
  spawnedBy: string | null;
  spawnDepth: number;
  teams: SessionPresentationTeamDto[];
  summary: string | null;
  workspaceLabel: string | null;
  contextOnly: boolean;
}

export interface SessionPresentationCountsDto {
  total: number;
  active: number;
  dormant: number;
  closed: number;
  working: number;
  waiting: number;
}

export interface SessionPresentationListParams {
  kind: SessionPresentationKind;
  cursor?: string;
  limit: number;
  query?: string;
}

export interface SessionPresentationListResult {
  sessions: SessionPresentationSummaryDto[];
  nextCursor: string | null;
  counts: SessionPresentationCountsDto;
  contextTruncated: boolean;
  revision: number;
}

function fail(field: string): never {
  throw new Error(`${field} is invalid`);
}

function bytes(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

function exact(value: Record<string, unknown>, keys: readonly string[], field: string): void {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    fail(field);
  }
}

function text(value: unknown, field: string, maximum = SESSION_PRESENTATION_MAX_TEXT_BYTES): string {
  if (typeof value !== 'string' || bytes(value) > maximum || CONTROL.test(value)) fail(field);
  return value;
}

function token(value: unknown, field: string, maximum = 256): string {
  const parsed = text(value, field, maximum);
  if (!parsed || !TOKEN.test(parsed)) fail(field);
  return parsed;
}

function integer(value: unknown, field: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) fail(field);
  return value as number;
}

function nullableInteger(value: unknown, field: string): number | null {
  return value === null ? null : integer(value, field);
}

function nullableText(value: unknown, field: string, maximum?: number): string | null {
  return value === null ? null : text(value, field, maximum);
}

function oneOf<T extends string>(
  value: unknown,
  allowed: readonly T[],
  field: string,
): T {
  if (typeof value !== 'string' || !allowed.includes(value as T)) fail(field);
  return value as T;
}

export function parseSessionPresentationListParams(
  value: unknown,
): SessionPresentationListParams {
  if (!isJsonObject(value)) fail('session.presentation.list.params');
  const keys = ['kind', 'limit'];
  if (value.cursor !== undefined) keys.push('cursor');
  if (value.query !== undefined) keys.push('query');
  exact(value, keys, 'session.presentation.list.params');
  const kind = oneOf(value.kind, ['history', 'live'], 'session.presentation.list.kind');
  const limit = integer(value.limit, 'session.presentation.list.limit');
  if (limit < 1 || limit > SESSION_PRESENTATION_MAX_PAGE_SIZE) {
    fail('session.presentation.list.limit');
  }
  const query = value.query === undefined
    ? undefined
    : text(value.query, 'session.presentation.list.query', SESSION_PRESENTATION_MAX_QUERY_BYTES);
  if (kind === 'live' && query !== undefined) fail('session.presentation.list.query');
  return {
    kind,
    limit,
    ...(value.cursor === undefined
      ? {}
      : { cursor: token(value.cursor, 'session.presentation.list.cursor', 512) }),
    ...(query === undefined ? {} : { query }),
  };
}

export function parseSessionPresentationSummary(
  value: unknown,
): SessionPresentationSummaryDto {
  if (!isJsonObject(value)) fail('session.presentation.session');
  exact(value, [
    'activity', 'adapterId', 'archived', 'context', 'contextOnly', 'createdAt', 'endedAt',
    'id', 'lifecycle', 'model', 'pinned', 'runtimeProvider', 'source', 'spawnDepth',
    'spawnedBy', 'summary', 'teams', 'thinking', 'title', 'updatedAt', 'workspaceLabel',
  ], 'session.presentation.session');
  if (typeof value.archived !== 'boolean' || typeof value.pinned !== 'boolean' ||
      typeof value.contextOnly !== 'boolean') fail('session.presentation.session.flags');
  if (!Array.isArray(value.teams) || value.teams.length > SESSION_PRESENTATION_MAX_TEAMS) {
    fail('session.presentation.session.teams');
  }
  const teams = value.teams.map((team, index): SessionPresentationTeamDto => {
    if (!isJsonObject(team)) fail(`session.presentation.session.teams.${index}`);
    exact(team, ['joinedAt', 'role', 'teamId', 'teamName'], `session.presentation.session.teams.${index}`);
    return {
      teamId: token(team.teamId, `session.presentation.session.teams.${index}.teamId`),
      teamName: text(team.teamName, `session.presentation.session.teams.${index}.teamName`, 512),
      role: oneOf(team.role, ['lead', 'teammate'], `session.presentation.session.teams.${index}.role`),
      joinedAt: integer(team.joinedAt, `session.presentation.session.teams.${index}.joinedAt`),
    };
  });
  if (new Set(teams.map((team) => team.teamId)).size !== teams.length) {
    fail('session.presentation.session.teams');
  }
  let context: SessionPresentationContextDto | null = null;
  if (value.context !== null) {
    if (!isJsonObject(value.context)) fail('session.presentation.session.context');
    exact(value.context, ['usedTokens', 'windowTokens'], 'session.presentation.session.context');
    context = {
      usedTokens: nullableInteger(value.context.usedTokens, 'session.presentation.session.context.usedTokens'),
      windowTokens: nullableInteger(value.context.windowTokens, 'session.presentation.session.context.windowTokens'),
    };
  }
  const spawnDepth = integer(value.spawnDepth, 'session.presentation.session.spawnDepth');
  if (spawnDepth > 32) fail('session.presentation.session.spawnDepth');
  return {
    id: token(value.id, 'session.presentation.session.id'),
    adapterId: token(value.adapterId, 'session.presentation.session.adapterId'),
    title: text(value.title, 'session.presentation.session.title', 512),
    source: oneOf(value.source, ['cli', 'sdk'], 'session.presentation.session.source'),
    lifecycle: oneOf(value.lifecycle, ['active', 'closed', 'dormant'], 'session.presentation.session.lifecycle'),
    activity: oneOf(value.activity, ['finished', 'idle', 'waiting', 'working'], 'session.presentation.session.activity'),
    archived: value.archived,
    pinned: value.pinned,
    createdAt: integer(value.createdAt, 'session.presentation.session.createdAt'),
    updatedAt: integer(value.updatedAt, 'session.presentation.session.updatedAt'),
    endedAt: nullableInteger(value.endedAt, 'session.presentation.session.endedAt'),
    model: nullableText(value.model, 'session.presentation.session.model', 512),
    thinking: nullableText(value.thinking, 'session.presentation.session.thinking', 256),
    runtimeProvider: nullableText(value.runtimeProvider, 'session.presentation.session.runtimeProvider', 256),
    context,
    spawnedBy: value.spawnedBy === null
      ? null
      : token(value.spawnedBy, 'session.presentation.session.spawnedBy'),
    spawnDepth,
    teams,
    summary: nullableText(value.summary, 'session.presentation.session.summary'),
    workspaceLabel: nullableText(value.workspaceLabel, 'session.presentation.session.workspaceLabel', 512),
    contextOnly: value.contextOnly,
  };
}

function parseCounts(value: unknown): SessionPresentationCountsDto {
  if (!isJsonObject(value)) fail('session.presentation.counts');
  exact(value, ['active', 'closed', 'dormant', 'total', 'waiting', 'working'], 'session.presentation.counts');
  return {
    total: integer(value.total, 'session.presentation.counts.total'),
    active: integer(value.active, 'session.presentation.counts.active'),
    dormant: integer(value.dormant, 'session.presentation.counts.dormant'),
    closed: integer(value.closed, 'session.presentation.counts.closed'),
    working: integer(value.working, 'session.presentation.counts.working'),
    waiting: integer(value.waiting, 'session.presentation.counts.waiting'),
  };
}

export function parseSessionPresentationListResult(
  value: unknown,
  requestedLimit = SESSION_PRESENTATION_MAX_PAGE_SIZE,
): SessionPresentationListResult {
  if (!isJsonObject(value)) fail('session.presentation.list.result');
  exact(value, ['contextTruncated', 'counts', 'nextCursor', 'revision', 'sessions'],
    'session.presentation.list.result');
  const limit = integer(requestedLimit, 'session.presentation.list.requestedLimit');
  if (limit < 1 || limit > SESSION_PRESENTATION_MAX_PAGE_SIZE || !Array.isArray(value.sessions) ||
      value.sessions.length > limit + SESSION_PRESENTATION_MAX_CONTEXT_ROWS ||
      typeof value.contextTruncated !== 'boolean') fail('session.presentation.list.sessions');
  const sessions = value.sessions.map(parseSessionPresentationSummary);
  if (new Set(sessions.map((session) => session.id)).size !== sessions.length ||
      sessions.filter((session) => !session.contextOnly).length > limit) {
    fail('session.presentation.list.sessions');
  }
  const counts = parseCounts(value.counts);
  if (counts.total < sessions.filter((session) => !session.contextOnly).length) {
    fail('session.presentation.counts.total');
  }
  return {
    sessions,
    nextCursor: value.nextCursor === null
      ? null
      : token(value.nextCursor, 'session.presentation.list.nextCursor', 512),
    counts,
    contextTruncated: value.contextTruncated,
    revision: integer(value.revision, 'session.presentation.list.revision'),
  };
}
