import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SessionRecord } from '@shared/types';
import { transferHandOffResources } from '../tools/handlers/hand-off-session/resource-transfer-coordinator';

const mocks = vi.hoisted(() => ({
  eventEmit: vi.fn(),
  notifyTeamMembershipChanged: vi.fn(),
  setCwdReleaseMarker: vi.fn(),
  teamRepo: {
    findActiveMembershipsBySession: vi.fn(),
    findActiveTeamMembershipsBySession: vi.fn(),
    get: vi.fn(),
    swapLead: vi.fn(),
    addMember: vi.fn(),
    leaveTeam: vi.fn(),
    findActiveMembershipIn: vi.fn(),
  },
  taskRepo: {
    reassignOwner: vi.fn(),
  },
  warn: vi.fn(),
}));

vi.mock('@main/event-bus', () => ({
  eventBus: { emit: mocks.eventEmit },
}));

vi.mock('@main/session/manager', () => ({
  sessionManager: { notifyTeamMembershipChanged: mocks.notifyTeamMembershipChanged },
}));

vi.mock('@main/store/session-repo', () => ({
  sessionRepo: { setCwdReleaseMarker: mocks.setCwdReleaseMarker },
}));

vi.mock('@main/store/agent-deck-team-repo', () => ({
  agentDeckTeamRepo: mocks.teamRepo,
}));

vi.mock('@main/store/task-repo', () => ({
  taskRepo: mocks.taskRepo,
}));

vi.mock('@main/utils/logger', () => ({
  default: { scope: () => ({ warn: mocks.warn }) },
}));

function callerRow(overrides: Partial<SessionRecord> = {}): SessionRecord {
  return {
    id: 'caller-sid',
    agentId: 'claude-code',
    cwd: '/repo',
    title: 'caller',
    source: 'sdk',
    lifecycle: 'active',
    activity: 'idle',
    startedAt: 1,
    lastEventAt: 1,
    endedAt: null,
    archivedAt: null,
    ...overrides,
  } as SessionRecord;
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.teamRepo.get.mockReturnValue({ id: 'team', archivedAt: null });
  mocks.teamRepo.findActiveTeamMembershipsBySession.mockImplementation((sid: string) =>
    mocks.teamRepo.findActiveMembershipsBySession(sid),
  );
  mocks.teamRepo.swapLead.mockReturnValue({ swapped: true });
  mocks.teamRepo.addMember.mockReturnValue(undefined);
  mocks.teamRepo.leaveTeam.mockReturnValue(null);
  mocks.teamRepo.findActiveMembershipIn.mockReturnValue(null);
  mocks.taskRepo.reassignOwner.mockReturnValue(0);
});

describe('transferHandOffResources', () => {
  it('transfers lead memberships, teammate memberships, tasks, and marker', () => {
    mocks.teamRepo.findActiveMembershipsBySession.mockReturnValue([
      { teamId: 'team-lead', role: 'lead' },
      { teamId: 'team-mate', role: 'teammate' },
    ]);
    mocks.taskRepo.reassignOwner.mockReturnValue(4);

    const result = transferHandOffResources({
      callerSessionId: 'caller-sid',
      callerRow: callerRow({ cwdReleaseMarker: '/repo/.agent-deck/worktrees/w1' }),
      newSessionId: 'successor-sid',
    });

    expect(result).toEqual({
      teams: {
        status: 'ok',
        transferred: [
          { teamId: 'team-lead', role: 'lead' },
          { teamId: 'team-mate', role: 'teammate' },
        ],
        skipped: [],
        failed: [],
      },
      tasks: { status: 'ok', count: 4 },
      worktreeMarker: { status: 'ok', marker: '/repo/.agent-deck/worktrees/w1' },
    });
    expect(mocks.teamRepo.swapLead).toHaveBeenCalledWith(
      'team-lead',
      'caller-sid',
      'successor-sid',
    );
    expect(mocks.teamRepo.addMember).toHaveBeenCalledWith({
      teamId: 'team-mate',
      sessionId: 'successor-sid',
      role: 'teammate',
    });
    expect(mocks.taskRepo.reassignOwner).toHaveBeenCalledWith('caller-sid', 'successor-sid', {
      policy: 'preserve-team',
    });
    expect(mocks.setCwdReleaseMarker).toHaveBeenCalledWith(
      'successor-sid',
      '/repo/.agent-deck/worktrees/w1',
    );
  });

  it('skips archived teams without failing the handoff resource transfer', () => {
    mocks.teamRepo.findActiveMembershipsBySession.mockReturnValue([
      { teamId: 'team-archived', role: 'lead' },
    ]);
    mocks.teamRepo.findActiveTeamMembershipsBySession.mockReturnValue([]);
    mocks.teamRepo.get.mockReturnValue({ id: 'team-archived', archivedAt: 123 });
    mocks.taskRepo.reassignOwner.mockReturnValue(1);

    const result = transferHandOffResources({
      callerSessionId: 'caller-sid',
      callerRow: callerRow(),
      newSessionId: 'successor-sid',
    });

    expect(result).toEqual({
      teams: {
        status: 'ok',
        transferred: [],
        skipped: [{ teamId: 'team-archived', role: 'lead', reason: 'team-archived' }],
        failed: [],
      },
      tasks: { status: 'ok', count: 1 },
      worktreeMarker: { status: 'skipped', marker: null },
    });
    expect(mocks.teamRepo.swapLead).not.toHaveBeenCalled();
    expect(mocks.teamRepo.addMember).not.toHaveBeenCalled();
    expect(mocks.taskRepo.reassignOwner).toHaveBeenCalledWith('caller-sid', 'successor-sid', {
      policy: 'preserve-team',
    });
  });

  it('transfers active teams while reporting archived memberships as skipped', () => {
    mocks.teamRepo.findActiveMembershipsBySession.mockReturnValue([
      { teamId: 'team-archived', role: 'lead' },
      { teamId: 'team-active', role: 'lead' },
    ]);
    mocks.teamRepo.findActiveTeamMembershipsBySession.mockReturnValue([
      { teamId: 'team-active', role: 'lead' },
    ]);
    mocks.teamRepo.get.mockImplementation((teamId: string) =>
      teamId === 'team-archived'
        ? { id: teamId, archivedAt: 123 }
        : { id: teamId, archivedAt: null },
    );

    const result = transferHandOffResources({
      callerSessionId: 'caller-sid',
      callerRow: callerRow(),
      newSessionId: 'successor-sid',
    });

    expect(result.teams).toEqual({
      status: 'ok',
      transferred: [{ teamId: 'team-active', role: 'lead' }],
      skipped: [{ teamId: 'team-archived', role: 'lead', reason: 'team-archived' }],
      failed: [],
    });
    expect(mocks.teamRepo.swapLead).toHaveBeenCalledTimes(1);
    expect(mocks.teamRepo.swapLead).toHaveBeenCalledWith(
      'team-active',
      'caller-sid',
      'successor-sid',
    );
  });

  it('rolls back tasks and marker when team transfer fails', () => {
    mocks.teamRepo.findActiveMembershipsBySession.mockReturnValue([
      { teamId: 'team-lead', role: 'lead' },
    ]);
    mocks.teamRepo.swapLead.mockReturnValue({ swapped: false, reason: 'membership race' });
    mocks.taskRepo.reassignOwner
      .mockReturnValueOnce(2)
      .mockReturnValueOnce(2);

    const result = transferHandOffResources({
      callerSessionId: 'caller-sid',
      callerRow: callerRow({ cwdReleaseMarker: '/repo/.agent-deck/worktrees/w1' }),
      newSessionId: 'successor-sid',
    });

    expect(result.teams.status).toBe('failed');
    expect(result.teams.failed).toEqual([
      { teamId: 'team-lead', role: 'lead', reason: 'membership race' },
    ]);
    expect(result.tasks).toEqual({
      status: 'failed',
      count: 0,
      error: 'team transfer failed',
    });
    expect(result.worktreeMarker).toEqual({
      status: 'skipped',
      marker: '/repo/.agent-deck/worktrees/w1',
    });
    expect(mocks.taskRepo.reassignOwner).toHaveBeenNthCalledWith(
      1,
      'caller-sid',
      'successor-sid',
      { policy: 'preserve-team' },
    );
    expect(mocks.taskRepo.reassignOwner).toHaveBeenNthCalledWith(
      2,
      'successor-sid',
      'caller-sid',
      { policy: 'preserve-team' },
    );
    expect(mocks.setCwdReleaseMarker).toHaveBeenNthCalledWith(
      1,
      'successor-sid',
      '/repo/.agent-deck/worktrees/w1',
    );
    expect(mocks.setCwdReleaseMarker).toHaveBeenNthCalledWith(2, 'successor-sid', null);
  });

  it('rolls back earlier team mutations when a later team transfer fails', () => {
    mocks.teamRepo.findActiveMembershipsBySession.mockReturnValue([
      { teamId: 'team-a', role: 'lead' },
      { teamId: 'team-b', role: 'lead' },
    ]);
    mocks.teamRepo.swapLead
      .mockReturnValueOnce({ swapped: true })
      .mockReturnValueOnce({ swapped: false, reason: 'membership race' })
      .mockReturnValueOnce({ swapped: true });

    const result = transferHandOffResources({
      callerSessionId: 'caller-sid',
      callerRow: callerRow({ cwdReleaseMarker: '/repo/.agent-deck/worktrees/w1' }),
      newSessionId: 'successor-sid',
    });

    expect(result.teams).toEqual({
      status: 'failed',
      transferred: [],
      skipped: [],
      failed: [{ teamId: 'team-b', role: 'lead', reason: 'membership race' }],
    });
    expect(mocks.teamRepo.swapLead).toHaveBeenNthCalledWith(
      1,
      'team-a',
      'caller-sid',
      'successor-sid',
    );
    expect(mocks.teamRepo.swapLead).toHaveBeenNthCalledWith(
      2,
      'team-b',
      'caller-sid',
      'successor-sid',
    );
    expect(mocks.teamRepo.swapLead).toHaveBeenNthCalledWith(
      3,
      'team-a',
      'successor-sid',
      'caller-sid',
    );
    expect(result.tasks).toEqual({
      status: 'failed',
      count: 0,
      error: 'team transfer failed',
    });
    expect(mocks.taskRepo.reassignOwner).toHaveBeenCalledWith('caller-sid', 'successor-sid', {
      policy: 'preserve-team',
    });
    expect(mocks.setCwdReleaseMarker).toHaveBeenNthCalledWith(
      1,
      'successor-sid',
      '/repo/.agent-deck/worktrees/w1',
    );
    expect(mocks.setCwdReleaseMarker).toHaveBeenNthCalledWith(2, 'successor-sid', null);
    expect(mocks.eventEmit).not.toHaveBeenCalled();
    expect(mocks.notifyTeamMembershipChanged).not.toHaveBeenCalled();
  });

  it('rolls back marker and skips teams when task transfer fails', () => {
    mocks.teamRepo.findActiveMembershipsBySession.mockReturnValue([]);
    mocks.taskRepo.reassignOwner.mockImplementation(() => {
      throw new Error('task db failed');
    });

    const result = transferHandOffResources({
      callerSessionId: 'caller-sid',
      callerRow: callerRow({ cwdReleaseMarker: '/repo/.agent-deck/worktrees/w1' }),
      newSessionId: 'successor-sid',
    });

    expect(result.teams).toEqual({
      status: 'failed',
      transferred: [],
      skipped: [],
      failed: [
        {
          teamId: '*',
          role: 'teammate',
          reason: 'skipped team transfer because task transfer failed',
        },
      ],
    });
    expect(result.tasks).toEqual({
      status: 'failed',
      count: 0,
      error: 'task db failed',
    });
    expect(result.worktreeMarker).toEqual({
      status: 'skipped',
      marker: '/repo/.agent-deck/worktrees/w1',
    });
    expect(mocks.setCwdReleaseMarker).toHaveBeenNthCalledWith(
      1,
      'successor-sid',
      '/repo/.agent-deck/worktrees/w1',
    );
    expect(mocks.setCwdReleaseMarker).toHaveBeenNthCalledWith(2, 'successor-sid', null);
    expect(mocks.teamRepo.findActiveMembershipsBySession).not.toHaveBeenCalled();
  });
});
