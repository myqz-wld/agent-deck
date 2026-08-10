import {
  parseSessionEventListResult,
  type SessionEventDto,
} from './session-events';
import {
  parseSessionTaskListResult,
  type SessionTaskDto,
} from './session-tasks';
import { SessionConsoleContractError } from './session-console-common';

export const TEAM_LIST_MAX_ITEMS = 200;
export const TEAM_MEMBER_MAX_ITEMS = 500;
export const TEAM_SESSION_MAX_ITEMS = 1_000;
export const TEAM_EVENT_MAX_ITEMS = 50;
export const TEAM_TASK_MAX_ITEMS = 200;
export const TEAM_MESSAGE_MAX_ITEMS = 100;
// Leave headroom for the daemon response envelope inside the 4 MiB transport frame.
export const TEAM_RESPONSE_MAX_BYTES = 3 * 1024 * 1024;

export type TeamMemberRoleDto = 'lead' | 'teammate';
export type TeamArchiveReasonDto =
  | 'last-lead-archived'
  | 'last-lead-closed'
  | 'last-lead-deleted'
  | 'scheduler'
  | 'user-action';
export type TeamMessageStatusDto =
  | 'pending'
  | 'delivering'
  | 'delivered'
  | 'failed'
  | 'cancelled';

export interface TeamListParams {
  includeArchived: boolean;
  limit: number;
}

export interface TeamGetParams { teamId: string }
export interface TeamArchiveParams { teamId: string }
export interface TeamShutdownParams { teamId: string }
export interface TeamAddMemberParams {
  teamId: string;
  sessionId: string;
  role: TeamMemberRoleDto;
}

export interface TeamSummaryDto {
  id: string;
  name: string;
  createdAt: number;
  archivedAt: number | null;
  memberCount: number;
  lastEventAt: number;
}

export interface TeamSessionDto {
  id: string;
  adapterId: string;
  title: string;
  lifecycle: 'active' | 'dormant' | 'closed';
  lastEventAt: number;
  archivedAt: number | null;
  spawnedBy: string | null;
}

export interface TeamMemberDto {
  teamId: string;
  sessionId: string;
  role: TeamMemberRoleDto;
  displayName: string | null;
  joinedAt: number;
  leftAt: number | null;
}

export interface TeamPendingCountsDto {
  sessionId: string;
  permissions: number;
  questions: number;
  plans: number;
  diffs: number;
  total: number;
}

export interface TeamMessageDto {
  id: string;
  fromSessionId: string;
  toSessionId: string;
  body: string;
  status: TeamMessageStatusDto;
  statusReason: string | null;
  sentAt: number;
  replyToMessageId: string | null;
}

export interface TeamDetailDto {
  id: string;
  name: string;
  createdAt: number;
  archivedAt: number | null;
  archiveReason: TeamArchiveReasonDto | null;
  members: TeamMemberDto[];
  sessions: TeamSessionDto[];
  pending: TeamPendingCountsDto[];
  recentEvents: SessionEventDto[];
  tasks: SessionTaskDto[];
  recentMessages: TeamMessageDto[];
}

export interface TeamListResult { teams: TeamSummaryDto[]; revision: number }
export interface TeamGetResult { team: TeamDetailDto | null; revision: number }
export interface TeamMutationResult { team: TeamSummaryDto | null; revision: number }
export interface TeamAddMemberResult { member: TeamMemberDto; revision: number }
export interface TeamShutdownResult {
  closed: string[];
  failed: Array<{ sessionId: string; reason: string }>;
  revision: number;
}

const TOKEN = /^[A-Za-z0-9][A-Za-z0-9._:@-]*$/;
const CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f\u2028\u2029]/u;

function fail(field: string): never { throw new SessionConsoleContractError(field); }
function object(value: unknown, field: string): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) fail(field);
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) fail(field);
  return value as Record<string, unknown>;
}
function exact(value: Record<string, unknown>, keys: readonly string[], field: string): void {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    fail(field);
  }
}
function bytes(value: string): number { return new TextEncoder().encode(value).byteLength; }
function token(value: unknown, field: string): string {
  if (typeof value !== 'string' || !TOKEN.test(value) || CONTROL.test(value) || bytes(value) > 256) {
    fail(field);
  }
  return value;
}
function text(value: unknown, field: string, maximum: number, nonempty = false): string {
  if (
    typeof value !== 'string' || (nonempty && value.trim().length === 0) ||
    CONTROL.test(value) || bytes(value) > maximum
  ) fail(field);
  return value;
}
function integer(value: unknown, field: string, maximum = Number.MAX_SAFE_INTEGER): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0 || (value as number) > maximum) {
    fail(field);
  }
  return value as number;
}
function nullableInteger(value: unknown, field: string): number | null {
  return value === null ? null : integer(value, field);
}
function boolean(value: unknown, field: string): boolean {
  if (typeof value !== 'boolean') fail(field);
  return value;
}
function revision(value: unknown, field: string): number { return integer(value, field); }
function boundedResult<T>(value: T, field: string): T {
  if (bytes(JSON.stringify(value)) > TEAM_RESPONSE_MAX_BYTES) fail(field);
  return value;
}

export function parseTeamListParams(value: unknown): TeamListParams {
  const raw = object(value, 'teams.list.params');
  exact(raw, ['includeArchived', 'limit'], 'teams.list.params');
  const limit = integer(raw.limit, 'teams.list.limit', TEAM_LIST_MAX_ITEMS);
  if (limit < 1) fail('teams.list.limit');
  return {
    includeArchived: boolean(raw.includeArchived, 'teams.list.includeArchived'),
    limit,
  };
}

function teamTarget(value: unknown, field: string): TeamGetParams {
  const raw = object(value, `${field}.params`);
  exact(raw, ['teamId'], `${field}.params`);
  return { teamId: token(raw.teamId, `${field}.teamId`) };
}

export function parseTeamGetParams(value: unknown): TeamGetParams {
  return teamTarget(value, 'teams.get');
}
export function parseTeamArchiveParams(value: unknown): TeamArchiveParams {
  return teamTarget(value, 'teams.archive');
}
export function parseTeamShutdownParams(value: unknown): TeamShutdownParams {
  return teamTarget(value, 'teams.shutdown-teammates');
}
export function parseTeamAddMemberParams(value: unknown): TeamAddMemberParams {
  const raw = object(value, 'teams.add-member.params');
  exact(raw, ['role', 'sessionId', 'teamId'], 'teams.add-member.params');
  if (raw.role !== 'lead' && raw.role !== 'teammate') fail('teams.add-member.role');
  return {
    teamId: token(raw.teamId, 'teams.add-member.teamId'),
    sessionId: token(raw.sessionId, 'teams.add-member.sessionId'),
    role: raw.role,
  };
}

function summary(value: unknown, field: string): TeamSummaryDto {
  const raw = object(value, field);
  exact(raw, ['archivedAt', 'createdAt', 'id', 'lastEventAt', 'memberCount', 'name'], field);
  return {
    id: token(raw.id, `${field}.id`),
    name: text(raw.name, `${field}.name`, 512, true),
    createdAt: integer(raw.createdAt, `${field}.createdAt`),
    archivedAt: nullableInteger(raw.archivedAt, `${field}.archivedAt`),
    memberCount: integer(raw.memberCount, `${field}.memberCount`, TEAM_MEMBER_MAX_ITEMS),
    lastEventAt: integer(raw.lastEventAt, `${field}.lastEventAt`),
  };
}

function member(value: unknown, field: string): TeamMemberDto {
  const raw = object(value, field);
  exact(raw, ['displayName', 'joinedAt', 'leftAt', 'role', 'sessionId', 'teamId'], field);
  if (raw.role !== 'lead' && raw.role !== 'teammate') fail(`${field}.role`);
  const parsed: TeamMemberDto = {
    teamId: token(raw.teamId, `${field}.teamId`),
    sessionId: token(raw.sessionId, `${field}.sessionId`),
    role: raw.role,
    displayName: raw.displayName === null
      ? null
      : text(raw.displayName, `${field}.displayName`, 512, true),
    joinedAt: integer(raw.joinedAt, `${field}.joinedAt`),
    leftAt: nullableInteger(raw.leftAt, `${field}.leftAt`),
  };
  if (parsed.leftAt !== null && parsed.leftAt < parsed.joinedAt) fail(`${field}.leftAt`);
  return parsed;
}

function session(value: unknown, field: string): TeamSessionDto {
  const raw = object(value, field);
  exact(raw, [
    'adapterId', 'archivedAt', 'id', 'lastEventAt', 'lifecycle', 'spawnedBy', 'title',
  ], field);
  if (!['active', 'dormant', 'closed'].includes(raw.lifecycle as string)) {
    fail(`${field}.lifecycle`);
  }
  return {
    id: token(raw.id, `${field}.id`),
    adapterId: token(raw.adapterId, `${field}.adapterId`),
    title: text(raw.title, `${field}.title`, 8 * 1024),
    lifecycle: raw.lifecycle as TeamSessionDto['lifecycle'],
    lastEventAt: integer(raw.lastEventAt, `${field}.lastEventAt`),
    archivedAt: nullableInteger(raw.archivedAt, `${field}.archivedAt`),
    spawnedBy: raw.spawnedBy === null ? null : token(raw.spawnedBy, `${field}.spawnedBy`),
  };
}

function pending(value: unknown, field: string): TeamPendingCountsDto {
  const raw = object(value, field);
  exact(raw, ['diffs', 'permissions', 'plans', 'questions', 'sessionId', 'total'], field);
  const parsed = {
    sessionId: token(raw.sessionId, `${field}.sessionId`),
    permissions: integer(raw.permissions, `${field}.permissions`, 10_000),
    questions: integer(raw.questions, `${field}.questions`, 10_000),
    plans: integer(raw.plans, `${field}.plans`, 10_000),
    diffs: integer(raw.diffs, `${field}.diffs`, 10_000),
    total: integer(raw.total, `${field}.total`, 40_000),
  };
  if (parsed.total !== parsed.permissions + parsed.questions + parsed.plans + parsed.diffs) fail(field);
  return parsed;
}

function message(value: unknown, field: string): TeamMessageDto {
  const raw = object(value, field);
  exact(raw, [
    'body', 'fromSessionId', 'id', 'replyToMessageId', 'sentAt', 'status',
    'statusReason', 'toSessionId',
  ], field);
  const statuses: readonly TeamMessageStatusDto[] = [
    'pending', 'delivering', 'delivered', 'failed', 'cancelled',
  ];
  if (!statuses.includes(raw.status as TeamMessageStatusDto)) fail(`${field}.status`);
  return {
    id: token(raw.id, `${field}.id`),
    fromSessionId: token(raw.fromSessionId, `${field}.fromSessionId`),
    toSessionId: token(raw.toSessionId, `${field}.toSessionId`),
    body: text(raw.body, `${field}.body`, 64 * 1024),
    status: raw.status as TeamMessageStatusDto,
    statusReason: raw.statusReason === null
      ? null
      : text(raw.statusReason, `${field}.statusReason`, 4 * 1024),
    sentAt: integer(raw.sentAt, `${field}.sentAt`),
    replyToMessageId: raw.replyToMessageId === null
      ? null
      : token(raw.replyToMessageId, `${field}.replyToMessageId`),
  };
}

function detail(value: unknown, revisionValue: number): TeamDetailDto {
  const raw = object(value, 'teams.get.team');
  exact(raw, [
    'archiveReason', 'archivedAt', 'createdAt', 'id', 'members', 'name', 'pending',
    'recentEvents', 'recentMessages', 'sessions', 'tasks',
  ], 'teams.get.team');
  if (!Array.isArray(raw.members) || raw.members.length > TEAM_MEMBER_MAX_ITEMS) fail('teams.get.members');
  if (!Array.isArray(raw.sessions) || raw.sessions.length > TEAM_SESSION_MAX_ITEMS) fail('teams.get.sessions');
  if (!Array.isArray(raw.pending) || raw.pending.length > TEAM_MEMBER_MAX_ITEMS) fail('teams.get.pending');
  if (!Array.isArray(raw.recentEvents) || raw.recentEvents.length > TEAM_EVENT_MAX_ITEMS) fail('teams.get.events');
  if (!Array.isArray(raw.tasks) || raw.tasks.length > TEAM_TASK_MAX_ITEMS) fail('teams.get.tasks');
  if (!Array.isArray(raw.recentMessages) || raw.recentMessages.length > TEAM_MESSAGE_MAX_ITEMS) fail('teams.get.messages');
  const archiveReasons: readonly TeamArchiveReasonDto[] = [
    'last-lead-archived', 'last-lead-closed', 'last-lead-deleted', 'scheduler', 'user-action',
  ];
  if (raw.archiveReason !== null && !archiveReasons.includes(raw.archiveReason as TeamArchiveReasonDto)) {
    fail('teams.get.archiveReason');
  }
  const teamId = token(raw.id, 'teams.get.id');
  const sessions = raw.sessions.map((item, index) => session(item, `teams.get.sessions[${index}]`));
  const sessionIds = new Set(sessions.map((item) => item.id));
  if (sessionIds.size !== sessions.length) fail('teams.get.sessions');
  const events = raw.recentEvents.map((item, index) => {
    const rawEvent = object(item, `teams.get.events[${index}]`);
    const sessionId = token(rawEvent.sessionId, `teams.get.events[${index}].sessionId`);
    return parseSessionEventListResult(
      { events: [item], revision: revisionValue, truncated: false },
      sessionId,
      1,
    ).events[0]!;
  });
  if (
    new Set(events.map((item) => item.id)).size !== events.length ||
    events.some((item) => !sessionIds.has(item.sessionId))
  ) fail('teams.get.events');
  const tasks = parseSessionTaskListResult(
    { tasks: raw.tasks, revision: revisionValue },
    TEAM_TASK_MAX_ITEMS,
  ).tasks;
  if (tasks.some((item) => item.teamId !== teamId || !sessionIds.has(item.ownerSessionId))) {
    fail('teams.get.tasks');
  }
  const members = raw.members.map((item, index) => member(item, `teams.get.members[${index}]`));
  if (
    new Set(members.map((item) => item.sessionId)).size !== members.length ||
    members.some((item) => item.teamId !== teamId || !sessionIds.has(item.sessionId))
  ) fail('teams.get.members');
  const parsedPending = raw.pending.map((item, index) => pending(item, `teams.get.pending[${index}]`));
  if (
    new Set(parsedPending.map((item) => item.sessionId)).size !== parsedPending.length ||
    parsedPending.some((item) => !sessionIds.has(item.sessionId))
  ) fail('teams.get.pending');
  const recentMessages = raw.recentMessages.map((item, index) =>
    message(item, `teams.get.messages[${index}]`));
  // Message history deliberately survives a sender/recipient session being closed or deleted.
  // Keep message identity exact, but do not require either endpoint to remain in the live session
  // projection (AgentDeckMessage's durable-history contract explicitly permits that case).
  if (new Set(recentMessages.map((item) => item.id)).size !== recentMessages.length) {
    fail('teams.get.messages');
  }
  return {
    id: teamId,
    name: text(raw.name, 'teams.get.name', 512, true),
    createdAt: integer(raw.createdAt, 'teams.get.createdAt'),
    archivedAt: nullableInteger(raw.archivedAt, 'teams.get.archivedAt'),
    archiveReason: raw.archiveReason as TeamArchiveReasonDto | null,
    members,
    sessions,
    pending: parsedPending,
    recentEvents: events,
    tasks,
    recentMessages,
  };
}

export function parseTeamListResult(
  value: unknown,
  limit: number,
  includeArchived = true,
): TeamListResult {
  const raw = object(value, 'teams.list.result');
  exact(raw, ['revision', 'teams'], 'teams.list.result');
  if (!Array.isArray(raw.teams) || raw.teams.length > limit) fail('teams.list.teams');
  const result = {
    teams: raw.teams.map((item, index) => summary(item, `teams.list.teams[${index}]`)),
    revision: revision(raw.revision, 'teams.list.revision'),
  };
  if (new Set(result.teams.map((item) => item.id)).size !== result.teams.length) fail('teams.list.teams');
  if (!includeArchived && result.teams.some((item) => item.archivedAt !== null)) {
    fail('teams.list.teams');
  }
  return boundedResult(result, 'teams.list.result');
}

export function parseTeamGetResult(value: unknown, expectedTeamId?: string): TeamGetResult {
  const raw = object(value, 'teams.get.result');
  exact(raw, ['revision', 'team'], 'teams.get.result');
  const parsedRevision = revision(raw.revision, 'teams.get.revision');
  const result = {
    team: raw.team === null ? null : detail(raw.team, parsedRevision),
    revision: parsedRevision,
  };
  if (expectedTeamId !== undefined && result.team?.id !== expectedTeamId) {
    fail('teams.get.team.id');
  }
  return boundedResult(result, 'teams.get.result');
}

export function parseTeamMutationResult(value: unknown, expectedTeamId?: string): TeamMutationResult {
  const raw = object(value, 'teams.mutation.result');
  exact(raw, ['revision', 'team'], 'teams.mutation.result');
  const result = {
    team: raw.team === null ? null : summary(raw.team, 'teams.mutation.team'),
    revision: revision(raw.revision, 'teams.mutation.revision'),
  };
  if (expectedTeamId !== undefined && result.team?.id !== expectedTeamId) {
    fail('teams.mutation.team.id');
  }
  return result;
}

export function parseTeamAddMemberResult(
  value: unknown,
  expected?: TeamAddMemberParams,
): TeamAddMemberResult {
  const raw = object(value, 'teams.add-member.result');
  exact(raw, ['member', 'revision'], 'teams.add-member.result');
  const result = {
    member: member(raw.member, 'teams.add-member.member'),
    revision: revision(raw.revision, 'teams.add-member.revision'),
  };
  if (expected && (
    result.member.teamId !== expected.teamId ||
    result.member.sessionId !== expected.sessionId ||
    result.member.role !== expected.role
  )) fail('teams.add-member.member');
  return result;
}

export function parseTeamShutdownResult(value: unknown): TeamShutdownResult {
  const raw = object(value, 'teams.shutdown-teammates.result');
  exact(raw, ['closed', 'failed', 'revision'], 'teams.shutdown-teammates.result');
  if (!Array.isArray(raw.closed) || raw.closed.length > TEAM_MEMBER_MAX_ITEMS) fail('teams.shutdown.closed');
  if (!Array.isArray(raw.failed) || raw.failed.length > TEAM_MEMBER_MAX_ITEMS) fail('teams.shutdown.failed');
  const closed = raw.closed.map((item, index) =>
    token(item, `teams.shutdown.closed[${index}]`));
  const failed = raw.failed.map((item, index) => {
    const failure = object(item, `teams.shutdown.failed[${index}]`);
    exact(failure, ['reason', 'sessionId'], `teams.shutdown.failed[${index}]`);
    return {
      sessionId: token(failure.sessionId, `teams.shutdown.failed[${index}].sessionId`),
      reason: text(failure.reason, `teams.shutdown.failed[${index}].reason`, 4 * 1024, true),
    };
  });
  const failedIds = failed.map((item) => item.sessionId);
  if (
    new Set(closed).size !== closed.length || new Set(failedIds).size !== failedIds.length ||
    failedIds.some((sessionId) => closed.includes(sessionId))
  ) fail('teams.shutdown-teammates.result');
  return {
    closed,
    failed,
    revision: revision(raw.revision, 'teams.shutdown.revision'),
  };
}
