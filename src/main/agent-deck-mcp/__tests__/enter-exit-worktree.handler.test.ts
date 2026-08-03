import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { WorktreeTransitionRecord } from '@main/session/worktree-transition/types';
import { worktreeToolInvocationRegistry } from '@main/session/worktree-transition/tool-invocation-registry';
import type { HandlerContext, HandlerResult } from '../tools/helpers';

const harness = vi.hoisted(() => ({
  record: null as WorktreeTransitionRecord | null,
  reserve: vi.fn(() => 'tool-transition'),
  bind: vi.fn(),
  arm: vi.fn(),
  release: vi.fn(),
  releasePreparation: vi.fn(),
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
      lifecycle: 'active',
    }),
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
    generation: 1,
    direction: 'enter',
    phase,
    originalCwd: '/repo',
    targetCwd: '/repo/.agent-deck/worktrees/task',
    mainRepo: '/repo',
    worktreePath: '/repo/.agent-deck/worktrees/task',
    baseCommit: 'a'.repeat(40),
    toolUseId: 'tool-transition',
    continuationKey: 'cwd:test:1',
    continuationDelivered: false,
    discardChanges: false,
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
  expect(result.content).toEqual([]);
  return result.structuredContent!;
}

function enterDeps() {
  return {
    callerCwd: () => '/repo',
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
  harness.releasePreparation.mockImplementation(
    async (record: WorktreeTransitionRecord, failure: string) => {
      harness.record = {
        ...record,
        direction: 'enter',
        phase: record.direction === 'enter' ? 'cleared' : 'active',
        targetCwd:
          record.direction === 'enter'
            ? record.targetCwd
            : record.worktreePath,
        toolUseId: null,
        lastError: failure,
      };
      return harness.record;
    },
  );
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
      headMode: 'detached',
    });
    expect(harness.reserve).not.toHaveBeenCalled();
    expect(harness.arm).not.toHaveBeenCalled();
  });

  it('rejects a repeat while the original enter is still creating git state', async () => {
    harness.record = transition('creating');
    const result = await enterWorktreeHandler(
      { startPoint: 'HEAD' },
      ctx(),
      { implDeps: enterDeps() },
    );

    expect(result.isError).toBe(true);
    expect(JSON.parse(result.content[0]?.text ?? '{}')).toMatchObject({
      error: expect.stringContaining('in phase creating'),
      hint: expect.stringContaining('original enter_worktree call is still creating'),
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

  it('returns a current-only error when the caller has no active lease', async () => {
    const result = await exitWorktreeHandler({}, ctx());

    expect(result.isError).toBe(true);
    expect(JSON.parse(result.content[0]?.text ?? '{}')).toMatchObject({
      error: expect.stringContaining('has no active worktree lease'),
      hint: expect.stringContaining('Call enter_worktree first'),
    });
    expect(harness.reserve).not.toHaveBeenCalled();
    expect(harness.preflight).not.toHaveBeenCalled();
  });

  it('returns a structured lease to active when exit arming fails', async () => {
    harness.record = transition('active', { continuationDelivered: true });
    harness.arm.mockImplementationOnce(() => {
      throw new Error('adapter cannot arm');
    });
    const result = await exitWorktreeHandler({}, ctx());

    expect(result.isError).toBe(true);
    expect(harness.releasePreparation).toHaveBeenCalledOnce();
    expect(harness.record?.phase).toBe('active');
    expect(harness.cleanup).not.toHaveBeenCalled();
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

  it('does not retry cleanup until transition input is atomically sealed', async () => {
    harness.record = transition('cleanup_pending', {
      direction: 'exit',
      targetCwd: '/repo',
      continuationDelivered: true,
    });

    const result = await exitWorktreeHandler({}, ctx());

    expect(result.isError).toBe(true);
    expect(harness.cleanup).not.toHaveBeenCalled();
  });

  it('does not retry cleanup before the prior claimed invocation releases', async () => {
    harness.record = transition('cleanup_pending', {
      direction: 'exit',
      targetCwd: '/repo',
      toolUseId: null,
      continuationDelivered: true,
    });
    worktreeToolInvocationRegistry.observe({
      sessionId: 'caller-sid',
      agentId: 'codex-cli',
      kind: 'tool-use-start',
      payload: {
        toolUseId: 'prior-exit-tool',
        toolName: 'mcp__agent-deck__exit_worktree',
      },
      ts: Date.now(),
      source: 'sdk',
    });
    worktreeToolInvocationRegistry.reserve('caller-sid', 'exit');
    worktreeToolInvocationRegistry.bindGeneration(
      'caller-sid',
      'prior-exit-tool',
      1,
    );

    const result = await exitWorktreeHandler({}, ctx());
    worktreeToolInvocationRegistry.release('caller-sid', 'prior-exit-tool', 1);

    expect(result.isError).toBe(true);
    expect(harness.cleanup).not.toHaveBeenCalled();
  });

  it('retries cleanup only after cwd restoration and reports a completed cleanup state', async () => {
    harness.record = transition('cleanup_pending', {
      direction: 'exit',
      targetCwd: '/repo',
      toolUseId: null,
      continuationDelivered: true,
    });
    worktreeToolInvocationRegistry.observe({
      sessionId: 'caller-sid',
      agentId: 'codex-cli',
      kind: 'tool-use-start',
      payload: {
        toolUseId: 'cleanup-retry-tool',
        toolName: 'mcp__agent-deck__exit_worktree',
      },
      ts: Date.now(),
      source: 'sdk',
    });
    const result = await exitWorktreeHandler({}, ctx());
    worktreeToolInvocationRegistry.release('caller-sid', 'cleanup-retry-tool');
    expect(assertStructuredParity(result)).toMatchObject({
      transitionId: 'caller-sid:1',
      direction: 'exit',
      state: 'completed-cleanup',
      effectiveFrom: 'already-effective',
      worktreeRemoved: true,
    });
    expect(harness.cleanup).toHaveBeenCalledOnce();
    expect(harness.reserve).not.toHaveBeenCalled();
    expect(harness.record?.phase).toBe('cleared');
  });
});
