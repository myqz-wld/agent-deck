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
  adopt: vi.fn(),
  legacyRelease: vi.fn(),
  preflight: vi.fn(async () => {}),
  cleanup: vi.fn(async () => ({
    worktreeRemoved: true,
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
          workBranch: '',
          baseBranch: '',
          baseCommit: input.baseCommit,
          toolUseId: input.toolUseId,
          continuationKey: input.continuationKey,
          requestedAt: input.requestedAt,
          updatedAt: input.requestedAt,
        });
        return harness.record;
      },
      adoptLegacyExit: (input: {
        sessionId: string;
        originalCwd: string;
        mainRepo: string;
        worktreePath: string;
        headCommit: string;
        toolUseId: string;
        continuationKey: string;
        discardChanges: boolean;
        requestedAt: number;
      }) => {
        harness.adopt(input);
        harness.record = transition('exit_preflight', {
          sessionId: input.sessionId,
          generation: (harness.record?.generation ?? 0) + 1,
          direction: 'exit',
          originalCwd: input.originalCwd,
          targetCwd: input.originalCwd,
          mainRepo: input.mainRepo,
          worktreePath: input.worktreePath,
          workBranch: '',
          baseBranch: 'HEAD',
          baseCommit: input.headCommit,
          toolUseId: input.toolUseId,
          continuationKey: input.continuationKey,
          discardChanges: input.discardChanges,
          deleteBranch: false,
          requestedAt: input.requestedAt,
          updatedAt: input.requestedAt,
        });
        return harness.record;
      },
      releaseLegacyExitAdoption: (input: {
        updatedAt: number;
        lastError: string;
      }) => {
        harness.legacyRelease(input);
        harness.record = {
          ...harness.record!,
          phase: 'cleared',
          targetCwd: harness.record!.originalCwd,
          updatedAt: input.updatedAt,
          lastError: input.lastError,
        };
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
          deleteBranch: false,
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
      if (command.includes('HEAD^{commit}')) return 'a'.repeat(40);
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
  harness.adopt.mockClear();
  harness.legacyRelease.mockClear();
  harness.preflight.mockReset();
  harness.preflight.mockResolvedValue(undefined);
  harness.cleanup.mockReset();
  harness.cleanup.mockResolvedValue({
    worktreeRemoved: true,
  });
});

describe('structured automatic worktree handlers', () => {
  it('accepts enter only after durable preparation and arms exact-result correlation', async () => {
    const result = await enterWorktreeHandler(
      {
        startPoint: 'HEAD',
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
      startCommit: 'a'.repeat(40),
      headMode: 'detached',
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
      { startPoint: 'HEAD' },
      ctx(),
      { implDeps: enterDeps() },
    );
    expect(assertStructuredParity(result)).toMatchObject({
      transitionId: 'caller-sid:1',
      state: 'waiting-tool-result',
      startCommit: 'a'.repeat(40),
      headMode: 'legacy-attached',
    });
    expect(harness.reserve).not.toHaveBeenCalled();
    expect(harness.arm).not.toHaveBeenCalled();
  });

  it('accepts structured exit after preflight without removing the worktree in the handler', async () => {
    harness.record = transition('active', { continuationDelivered: true });
    const result = await exitWorktreeHandler(
      { discardChanges: false },
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

  it('adopts a detached legacy worktree and returns async acceptance without inline cleanup', async () => {
    const gitValues = [
      '/repo/.git',
      'a'.repeat(40),
      'refs/heads/main',
      '',
    ];
    const runGit = vi.fn(async (_args: string[], _cwd: string) => {
      const next = gitValues.shift();
      if (next === undefined) throw new Error('runGit mock exhausted');
      return next;
    });
    const result = await exitWorktreeHandler(
      { discardChanges: false },
      ctx(),
      {
        implDeps: {
          runGit,
          exists: () => true,
          realpath: (value) => value,
          callerMarker: () => '/repo/.agent-deck/worktrees/legacy',
          callerCwd: () => '/repo/.agent-deck/worktrees/legacy',
          clearCwdReleaseMarker: vi.fn(),
        },
      },
    );

    expect(assertStructuredParity(result)).toMatchObject({
      transitionId: 'caller-sid:1',
      direction: 'exit',
      state: 'waiting-tool-result',
      worktreePath: '/repo/.agent-deck/worktrees/legacy',
    });
    expect(harness.adopt).toHaveBeenCalledWith(
      expect.objectContaining({
        headCommit: 'a'.repeat(40),
        originalCwd: '/repo',
      }),
    );
    expect(runGit.mock.calls.map(([args]) => args)).not.toContainEqual([
      'worktree',
      'remove',
      '/repo/.agent-deck/worktrees/legacy',
    ]);
    expect(harness.cleanup).not.toHaveBeenCalled();
    expect(harness.arm).toHaveBeenCalledWith(
      expect.objectContaining({ phase: 'exit_preflight', direction: 'exit' }),
    );
    expect(harness.record?.phase).toBe('exit_waiting_tool_result');
  });

  it('falls back to the legacy marker when an adopted exit cannot be armed', async () => {
    const gitValues = [
      '/repo/.git',
      'a'.repeat(40),
      'refs/heads/main',
      '',
    ];
    harness.arm.mockImplementationOnce(() => {
      throw new Error('adapter cannot arm');
    });
    const result = await exitWorktreeHandler(
      {},
      ctx(),
      {
        implDeps: {
          runGit: async () => {
            const next = gitValues.shift();
            if (next === undefined) throw new Error('runGit mock exhausted');
            return next;
          },
          exists: () => true,
          realpath: (value) => value,
          callerMarker: () => '/repo/.agent-deck/worktrees/legacy',
          callerCwd: () => '/repo',
          clearCwdReleaseMarker: vi.fn(),
        },
      },
    );

    expect(result.isError).toBe(true);
    expect(harness.releasePreparation).toHaveBeenCalledOnce();
    expect(harness.legacyRelease).toHaveBeenCalledWith(
      expect.objectContaining({
        lastError: 'adapter cannot arm',
      }),
    );
    expect(harness.record?.phase).toBe('cleared');
    expect(harness.cleanup).not.toHaveBeenCalled();
  });

  it('completes legacy compatibility synchronously only for an absent target', async () => {
    const clearMarker = vi.fn();
    const result = await exitWorktreeHandler(
      {},
      ctx(),
      {
        implDeps: {
          runGit: vi.fn(),
          exists: () => false,
          realpath: (value) => value,
          callerMarker: () => '/repo/.agent-deck/worktrees/missing',
          callerCwd: () => '/repo',
          clearCwdReleaseMarker: clearMarker,
        },
      },
    );

    expect(assertStructuredParity(result)).toMatchObject({
      transitionId: null,
      state: 'completed-legacy',
      worktreePath: '/repo/.agent-deck/worktrees/missing',
      worktreeRemoved: false,
      markerCleared: true,
    });
    expect(clearMarker).toHaveBeenCalledWith('caller-sid');
    expect(harness.reserve).not.toHaveBeenCalled();
    expect(harness.adopt).not.toHaveBeenCalled();
  });

  it('rejects a mismatched legacy path before Git or transition reservation', async () => {
    const runGit = vi.fn();
    const result = await exitWorktreeHandler(
      { worktreePath: '/repo/.agent-deck/worktrees/other' },
      ctx(),
      {
        implDeps: {
          runGit,
          exists: () => true,
          realpath: (value) => value,
          callerMarker: () => '/repo/.agent-deck/worktrees/legacy',
          callerCwd: () => '/repo',
          clearCwdReleaseMarker: vi.fn(),
        },
      },
    );

    expect(result.isError).toBe(true);
    expect(JSON.parse(result.content[0]?.text ?? '{}').error).toContain(
      'does not match caller marker',
    );
    expect(runGit).not.toHaveBeenCalled();
    expect(harness.reserve).not.toHaveBeenCalled();
    expect(harness.adopt).not.toHaveBeenCalled();
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
