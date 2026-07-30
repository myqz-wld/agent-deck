import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { WorktreeTransitionRecord } from '@main/session/worktree-transition/types';
import type { HandlerContext, HandlerResult } from '../tools/helpers';

const harness = vi.hoisted(() => ({
  record: null as WorktreeTransitionRecord | null,
  reserve: vi.fn(() => 'tool-transition'),
  bind: vi.fn(),
  arm: vi.fn(),
  release: vi.fn(),
  releasePreparation: vi.fn(async () => {}),
  preflight: vi.fn(async () => {}),
  cleanup: vi.fn(async () => ({
    worktreeRemoved: true,
    branchDeleted: false,
    branchError: null as string | null,
  })),
}));

vi.mock('@main/store/session-repo', () => ({
  sessionRepo: {
    get: () => ({
      id: 'caller-sid',
      cwd: '/repo',
      cwdReleaseMarker: '/repo/.agent-deck/worktrees/task',
      lifecycle: 'active',
    }),
    setCwdReleaseMarker: vi.fn(),
    clearCwdReleaseMarker: vi.fn(),
  },
}));

vi.mock('@main/store/agent-deck-team-repo', () => ({
  agentDeckTeamRepo: {},
}));

vi.mock('@main/session/hand-off/ownership', () => ({
  sessionOwnershipLineage: vi.fn(),
  sessionOwnershipLineages: vi.fn(),
}));

vi.mock('@main/session/worktree-transition/coordinator', () => ({
  worktreeTransitionCoordinator: {
    reserveToolInvocation: harness.reserve,
    bindToolInvocation: harness.bind,
    arm: harness.arm,
    releaseToolInvocation: harness.release,
    releaseAbortedPreparation: harness.releasePreparation,
  },
}));

vi.mock('@main/session/worktree-transition/git-cleanup', () => ({
  preflightStructuredWorktreeExit: harness.preflight,
  cleanupStructuredWorktree: harness.cleanup,
}));

vi.mock('@main/store/worktree-transition-repo', async (importOriginal) => {
  const original = await importOriginal<
    typeof import('@main/store/worktree-transition-repo')
  >();
  return {
    ...original,
    worktreeTransitionRepo: {
      get: () => harness.record,
      createEnter: (input: {
        sessionId: string;
        originalCwd: string;
        targetCwd: string;
        mainRepo: string;
        worktreePath: string;
        workBranch: string;
        baseBranch: string;
        baseCommit: string;
        toolUseId: string;
        continuationKey: string;
        requestedAt: number;
      }) => {
        harness.record = transition('creating', {
          sessionId: input.sessionId,
          originalCwd: input.originalCwd,
          targetCwd: input.targetCwd,
          mainRepo: input.mainRepo,
          worktreePath: input.worktreePath,
          workBranch: input.workBranch,
          baseBranch: input.baseBranch,
          baseCommit: input.baseCommit,
          toolUseId: input.toolUseId,
          continuationKey: input.continuationKey,
          requestedAt: input.requestedAt,
          updatedAt: input.requestedAt,
        });
        return harness.record;
      },
      markEnterCreated: () => {
        harness.record = { ...harness.record!, phase: 'enter_waiting_tool_result' };
        return harness.record;
      },
      beginExitPreflight: (
        _sessionId: string,
        _generation: number,
        options: {
          toolUseId: string;
          continuationKey: string;
          discardChanges: boolean;
          deleteBranch: boolean;
          requestedAt: number;
        },
      ) => {
        harness.record = {
          ...harness.record!,
          direction: 'exit',
          phase: 'exit_preflight',
          targetCwd: harness.record!.originalCwd,
          toolUseId: options.toolUseId,
          continuationKey: options.continuationKey,
          continuationDelivered: false,
          discardChanges: options.discardChanges,
          deleteBranch: options.deleteBranch,
        };
        return harness.record;
      },
      compareAndSetPhase: (input: {
        next: WorktreeTransitionRecord['phase'];
        lastError?: string | null;
      }) => {
        harness.record = {
          ...harness.record!,
          phase: input.next,
          lastError: input.lastError ?? null,
        };
        return harness.record;
      },
      setLastError: vi.fn(),
    },
  };
});

import { enterWorktreeHandler } from '../tools/handlers/enter-worktree';
import { exitWorktreeHandler } from '../tools/handlers/exit-worktree';

function transition(
  phase: WorktreeTransitionRecord['phase'],
  overrides: Partial<WorktreeTransitionRecord> = {},
): WorktreeTransitionRecord {
  return {
    sessionId: 'caller-sid',
    formatVersion: 1,
    generation: 1,
    direction: 'enter',
    phase,
    originalCwd: '/repo',
    targetCwd: '/repo/.agent-deck/worktrees/task',
    mainRepo: '/repo',
    worktreePath: '/repo/.agent-deck/worktrees/task',
    workBranch: 'agent-deck/task',
    baseBranch: 'main',
    baseCommit: 'a'.repeat(40),
    toolUseId: 'tool-transition',
    continuationKey: 'cwd:test:1',
    continuationDelivered: false,
    discardChanges: false,
    deleteBranch: false,
    requestedAt: 1,
    updatedAt: 1,
    lastError: null,
    ...overrides,
  };
}

function ctx(): HandlerContext {
  return {
    caller: {
      callerSessionId: 'caller-sid',
      transport: 'in-process',
    },
  };
}

function assertStructuredParity(result: HandlerResult): Record<string, unknown> {
  expect(result.isError).not.toBe(true);
  expect(result.structuredContent).toBeDefined();
  expect(JSON.parse(result.content[0]?.text ?? '{}')).toEqual(
    result.structuredContent,
  );
  return result.structuredContent!;
}

function enterDeps() {
  return {
    callerCwd: () => '/repo',
    setCwdReleaseMarker: vi.fn(),
    exists: async () => false,
    mkdir: async () => undefined,
    now: () => 1,
    runGit: async (args: string[]) => {
      const command = args.join(' ');
      if (command === 'rev-parse --git-common-dir') return '/repo/.git';
      if (command.includes('refs/heads/main^{commit}')) return 'a'.repeat(40);
      if (command.includes('refs/heads/agent-deck/task')) {
        throw new Error('branch absent');
      }
      return '';
    },
  };
}

beforeEach(() => {
  harness.record = null;
  harness.reserve.mockClear();
  harness.bind.mockClear();
  harness.arm.mockClear();
  harness.release.mockClear();
  harness.releasePreparation.mockClear();
  harness.preflight.mockReset();
  harness.preflight.mockResolvedValue(undefined);
  harness.cleanup.mockReset();
  harness.cleanup.mockResolvedValue({
    worktreeRemoved: true,
    branchDeleted: false,
    branchError: null,
  });
});

describe('structured automatic worktree handlers', () => {
  it('accepts enter only after durable preparation and arms exact-result correlation', async () => {
    const result = await enterWorktreeHandler(
      {
        baseBranch: 'main',
        workBranch: 'agent-deck/task',
        worktreePath: '/repo/.agent-deck/worktrees/task',
      },
      ctx(),
      { implDeps: enterDeps() },
    );
    expect(assertStructuredParity(result)).toMatchObject({
      transitionId: 'caller-sid:1',
      direction: 'enter',
      state: 'waiting-tool-result',
      effectiveFrom: 'automatic-next-turn',
      markerSet: true,
    });
    expect(harness.bind).toHaveBeenCalledWith(
      'caller-sid',
      'tool-transition',
      1,
    );
    expect(harness.arm).toHaveBeenCalledWith(
      expect.objectContaining({ phase: 'enter_waiting_tool_result' }),
    );
  });

  it('returns an existing enter acceptance idempotently without creating git state again', async () => {
    harness.record = transition('enter_waiting_tool_result');
    const result = await enterWorktreeHandler(
      { baseBranch: 'main' },
      ctx(),
      { implDeps: enterDeps() },
    );
    expect(assertStructuredParity(result)).toMatchObject({
      transitionId: 'caller-sid:1',
      state: 'waiting-tool-result',
    });
    expect(harness.reserve).not.toHaveBeenCalled();
    expect(harness.arm).not.toHaveBeenCalled();
  });

  it('accepts structured exit after preflight without removing the worktree in the handler', async () => {
    harness.record = transition('active', { continuationDelivered: true });
    const result = await exitWorktreeHandler(
      { discardChanges: false, deleteBranch: false },
      ctx(),
    );
    expect(assertStructuredParity(result)).toMatchObject({
      transitionId: 'caller-sid:1',
      direction: 'exit',
      state: 'waiting-tool-result',
      effectiveFrom: 'automatic-next-turn',
    });
    expect(harness.preflight).toHaveBeenCalledOnce();
    expect(harness.cleanup).not.toHaveBeenCalled();
    expect(harness.arm).toHaveBeenCalledWith(
      expect.objectContaining({ phase: 'exit_preflight', direction: 'exit' }),
    );
    expect(harness.record?.phase).toBe('exit_waiting_tool_result');
  });

  it('returns an existing exit acceptance idempotently without repeating preflight', async () => {
    harness.record = transition('exit_waiting_tool_result', {
      direction: 'exit',
      targetCwd: '/repo',
      continuationDelivered: false,
    });
    const result = await exitWorktreeHandler({}, ctx());
    expect(assertStructuredParity(result)).toMatchObject({
      transitionId: 'caller-sid:1',
      direction: 'exit',
      state: 'waiting-tool-result',
    });
    expect(harness.preflight).not.toHaveBeenCalled();
    expect(harness.reserve).not.toHaveBeenCalled();
    expect(harness.arm).not.toHaveBeenCalled();
  });

  it('retries cleanup only after cwd restoration and reports a completed cleanup state', async () => {
    harness.record = transition('cleanup_pending', {
      direction: 'exit',
      targetCwd: '/repo',
      continuationDelivered: true,
    });
    const result = await exitWorktreeHandler({}, ctx());
    expect(assertStructuredParity(result)).toMatchObject({
      transitionId: 'caller-sid:1',
      direction: 'exit',
      state: 'completed-cleanup',
      effectiveFrom: 'already-effective',
      worktreeRemoved: true,
      markerCleared: true,
    });
    expect(harness.cleanup).toHaveBeenCalledOnce();
    expect(harness.reserve).not.toHaveBeenCalled();
    expect(harness.record?.phase).toBe('cleared');
  });
});
