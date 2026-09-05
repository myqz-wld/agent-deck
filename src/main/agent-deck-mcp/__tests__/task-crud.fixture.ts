/** Shared handler mocks and per-test reset for task authorization suites. */
import { vi, beforeEach } from 'vitest';
import { makeSessionRepoMock } from '@main/__tests__/_shared/mocks/session-repo';

// vi.hoisted 让 mock objects 在 vi.mock factory 执行前就 ready
const mocks = vi.hoisted(() => ({
  taskRepo: {
    create: vi.fn(),
    get: vi.fn(),
    list: vi.fn(),
    update: vi.fn(),
    delete: vi.fn(),
    reassignOwner: vi.fn(),
  },
  teamRepo: {
    findActiveMembershipsBySession: vi.fn<(sid: string) => Array<{ teamId: string; teamName: string; sessionId: string; role: string }>>(() => []),
    findActiveTeamMembershipsBySession: vi.fn<(sid: string) => Array<{ teamId: string; teamName: string; sessionId: string; role: string }>>(() => []),
    findActiveMembershipsBySessionIds: vi.fn<(sids: string[]) => Map<string, unknown[]>>(
      () => new Map(),
    ),
    findSharedActiveTeams: vi.fn<(a: string, b: string) => unknown[]>(() => []),
    listActiveMembers: vi.fn<(tid: string) => unknown[]>(() => []),
    get: vi.fn<(tid: string) => { id: string; name: string; archivedAt: number | null } | null>(),
  },
  eventBus: { emit: vi.fn() },
  sessionManager: { ingest: vi.fn() },
}));

// 整套 mock — handler 间接 import 这些
vi.mock('@main/store/session-repo', () => ({
  sessionRepo: makeSessionRepoMock({}),
}));
vi.mock('@main/store/task-repo', () => ({ taskRepo: mocks.taskRepo }));
vi.mock('@main/store/agent-deck-team-repo', () => ({ agentDeckTeamRepo: mocks.teamRepo }));
vi.mock('@main/event-bus', () => ({ eventBus: mocks.eventBus }));
vi.mock('@main/session/manager', () => ({ sessionManager: mocks.sessionManager }));

export const mockTaskRepo = mocks.taskRepo;
export const mockTeamRepo = mocks.teamRepo;
export const mockEventBus = mocks.eventBus;
export const mockSessionManager = mocks.sessionManager;

// import sessionRepo via mock 后 attach __sessions
import { sessionRepo } from '@main/store/session-repo';
export const mockSessions = (sessionRepo as unknown as { __sessions: Map<string, unknown> })
  .__sessions;

export { taskCreateHandler } from '../tools/handlers/task-create';
export { taskListHandler } from '../tools/handlers/task-list';
export { taskGetHandler } from '../tools/handlers/task-get';
export { taskUpdateHandler } from '../tools/handlers/task-update';
export { taskDeleteHandler } from '../tools/handlers/task-delete';
import type { HandlerContext } from '../tools/helpers';

export function makeCtx(callerSessionId: string): HandlerContext {
  return { caller: { callerSessionId, transport: 'in-process' } };
}

export function makeTaskRecord(overrides: Record<string, unknown> = {}) {
  const now = new Date().toISOString();
  return {
    id: 'task-1',
    ownerSessionId: 'sess-caller',
    teamId: null,
    subject: 'A',
    description: null,
    status: 'pending',
    activeForm: null,
    priority: 5,
    blocks: [],
    blockedBy: [],
    labels: [],
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

/** mock helper: caller 是 team-A active member（团队也 active）*/
export function setupCallerInTeam(callerSid: string, teamId: string, teamName = teamId): void {
  mockTeamRepo.findActiveMembershipsBySession.mockImplementation((sid: string) => {
    if (sid === callerSid) {
      return [{ teamId, teamName, sessionId: sid, role: 'lead' }];
    }
    return [];
  });
  mockTeamRepo.get.mockImplementation((tid: string) => {
    if (tid === teamId) return { id: tid, name: teamName, archivedAt: null };
    return null;
  });
}

beforeEach(() => {
  mockTaskRepo.create.mockReset();
  mockTaskRepo.get.mockReset();
  mockTaskRepo.list.mockReset();
  mockTaskRepo.update.mockReset();
  mockTaskRepo.delete.mockReset();
  mockTeamRepo.findActiveMembershipsBySession.mockReset().mockReturnValue([]);
  mockTeamRepo.findActiveTeamMembershipsBySession
    .mockReset()
    .mockImplementation((sid: string) => mockTeamRepo.findActiveMembershipsBySession(sid));
  mockTeamRepo.findActiveMembershipsBySessionIds.mockReset().mockReturnValue(new Map());
  mockTeamRepo.findSharedActiveTeams.mockReset().mockReturnValue([]);
  mockTeamRepo.listActiveMembers.mockReset().mockReturnValue([]);
  mockTeamRepo.get.mockReset();
  mockEventBus.emit.mockReset();
  mockSessionManager.ingest.mockReset();
  mockSessions.clear();
  // 默认 caller session 在 sessions 表
  mockSessions.set('sess-caller', { id: 'sess-caller', lifecycle: 'active' });
});
