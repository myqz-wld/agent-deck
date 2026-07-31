import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentEvent } from '@shared/types';
import type { WorktreeTransitionRecord } from '../types';

const harness = vi.hoisted(() => ({
  record: null as WorktreeTransitionRecord | null,
  interrupt: vi.fn(async () => {}),
  switchCwd: vi.fn(async () => ({ continuationAccepted: false })),
  release: vi.fn(),
  setCwd: vi.fn(),
  deliver: vi.fn(async () => {}),
  compareAndSetPhase: vi.fn(),
  setLastError: vi.fn(),
  emitStatus: vi.fn(),
  recover: vi.fn(async () => {}),
}));

vi.mock('@main/adapters/registry', () => ({
  adapterRegistry: {
    get: () => ({
      id: 'codex-cli',
      interruptSession: harness.interrupt,
      switchCwdForTransition: harness.switchCwd,
      releaseCwdTransition: harness.release,
      getRuntimeCwd: () => '/repo/worktree',
    }),
  },
}));

vi.mock('@main/store/session-repo', () => ({
  sessionRepo: {
    get: () => ({ id: 'session-a', agentId: 'codex-cli' }),
    setCwd: harness.setCwd,
  },
}));

vi.mock('@main/store/worktree-transition-repo', async (importOriginal) => {
  const original = await importOriginal<
    typeof import('@main/store/worktree-transition-repo')
  >();
  return {
    ...original,
    worktreeTransitionRepo: {
      get: () => harness.record,
      compareAndSetPhase: harness.compareAndSetPhase,
      setLastError: harness.setLastError,
    },
  };
});

vi.mock('../projection', () => ({
  emitWorktreeSessionUpsert: vi.fn(),
  emitWorktreeTransitionStatus: harness.emitStatus,
}));

vi.mock('../recovery', () => ({
  abortFailedEnterAtOriginalCwd: vi.fn(async () => {}),
  completeAcknowledgedEnter: vi.fn(async () => {}),
  completeAcknowledgedExit: vi.fn(async () => {}),
  recoverWorktreeTransition: harness.recover,
  restoreFailedExitAtWorktree: vi.fn(async () => {}),
}));

vi.mock('../transition-delivery', () => ({
  toAgentCwdTransition: (record: WorktreeTransitionRecord) => ({
    sessionId: record.sessionId,
    generation: record.generation,
    direction: record.direction,
    fromCwd: record.originalCwd,
    targetCwd: record.targetCwd,
    continuationKey: record.continuationKey,
    continuationText: 'continue',
  }),
  deliverTransitionWork: harness.deliver,
  replayAbortedTransitionInputs: vi.fn(async () => {}),
  compensateTransitionRuntime: vi.fn(async () => {}),
}));

import { WorktreeTransitionCoordinator } from '../coordinator';

function transition(
  overrides: Partial<WorktreeTransitionRecord> = {},
): WorktreeTransitionRecord {
  return {
    sessionId: 'session-a',
    formatVersion: 1,
    generation: 4,
    direction: 'enter',
    phase: 'enter_waiting_tool_result',
    originalCwd: '/repo',
    targetCwd: '/repo/worktree',
    mainRepo: '/repo',
    worktreePath: '/repo/worktree',
    baseCommit: 'a'.repeat(40),
    toolUseId: 'transition-tool',
    continuationKey: 'worktree-cwd:test',
    continuationDelivered: false,
    discardChanges: false,
    requestedAt: 1,
    updatedAt: 1,
    lastError: null,
    ...overrides,
  };
}

function event(
  kind: AgentEvent['kind'],
  payload: Record<string, unknown>,
): AgentEvent {
  return {
    sessionId: 'session-a',
    agentId: 'codex-cli',
    kind,
    payload,
    ts: 10,
    source: 'sdk',
  };
}

beforeEach(() => {
  harness.record = transition();
  harness.interrupt.mockClear();
  harness.switchCwd.mockClear();
  harness.release.mockClear();
  harness.setCwd.mockClear();
  harness.deliver.mockClear();
  harness.compareAndSetPhase.mockReset();
  harness.compareAndSetPhase.mockImplementation((input) => {
    harness.record = {
      ...harness.record!,
      phase: input.next,
      updatedAt: input.updatedAt,
    };
    return harness.record;
  });
  harness.setLastError.mockClear();
  harness.emitStatus.mockClear();
  harness.recover.mockClear();
});

describe('WorktreeTransitionCoordinator provider observation', () => {
  it('arms the expected interrupt only after the exact successful tool result', async () => {
    const coordinator = new WorktreeTransitionCoordinator();
    expect(
      coordinator.observe(
        event('tool-use-end', {
          toolUseId: 'other-tool',
          status: 'completed',
        }),
      ),
    ).toBe(true);
    await Promise.resolve();
    expect(harness.interrupt).not.toHaveBeenCalled();

    expect(
      coordinator.observe(
        event('tool-use-end', {
          toolUseId: 'transition-tool',
          status: 'completed',
          error: false,
        }),
      ),
    ).toBe(true);
    expect(harness.record?.phase).toBe('interrupting_enter_turn');
    await Promise.resolve();
    await Promise.resolve();
    expect(harness.interrupt).toHaveBeenCalledOnce();
    expect(harness.interrupt).toHaveBeenCalledWith('session-a');
  });

  it('recovers a failed result without interrupting the provider turn', async () => {
    const coordinator = new WorktreeTransitionCoordinator();
    coordinator.observe(
      event('tool-use-end', {
        toolUseId: 'transition-tool',
        status: 'failed',
        error: 'denied',
      }),
    );
    await Promise.resolve();
    await Promise.resolve();
    expect(harness.setLastError).toHaveBeenCalledWith(
      'session-a',
      4,
      expect.stringContaining('failed'),
      expect.any(Number),
    );
    expect(harness.interrupt).not.toHaveBeenCalled();
    expect(harness.recover).toHaveBeenCalledWith('session-a');
  });

  it('fences late old-turn work while retaining terminal and usage events', () => {
    const coordinator = new WorktreeTransitionCoordinator();
    harness.record = transition({ phase: 'interrupting_enter_turn' });
    expect(
      coordinator.observe(
        event('tool-use-start', {
          toolUseId: 'late',
          toolName: 'Bash',
        }),
      ),
    ).toBe(false);
    expect(coordinator.observe(event('message', { text: 'late' }))).toBe(false);
    expect(coordinator.observe(event('token-usage', { input: 12 }))).toBe(true);
    expect(coordinator.observe(event('context-usage', { used: 12 }))).toBe(true);
  });

  it('marks the expected terminal and finalizes the next cwd before releasing the gate', async () => {
    const coordinator = new WorktreeTransitionCoordinator();
    harness.record = transition({ phase: 'interrupting_enter_turn' });
    const finished = event('finished', { reason: 'interrupted' });
    expect(coordinator.observe(finished)).toBe(true);
    expect(finished.payload).toMatchObject({
      expectedWorktreeTransition: {
        generation: 4,
        direction: 'enter',
      },
    });

    await Promise.resolve();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(harness.switchCwd).toHaveBeenCalledOnce();
    expect(harness.setCwd).toHaveBeenCalledWith(
      'session-a',
      '/repo/worktree',
    );
    expect(harness.deliver).toHaveBeenCalledOnce();
    expect(harness.record?.phase).toBe('active');
    expect(harness.release).toHaveBeenCalledWith('session-a', 4);
  });
});
