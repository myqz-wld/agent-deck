import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentAdapter } from '@main/adapters/types';
import type {
  WorktreeTransitionQueuedInput,
  WorktreeTransitionRecord,
} from '../types';

const harness = vi.hoisted(() => ({
  pending: [] as WorktreeTransitionQueuedInput[],
  enqueue: vi.fn(async (..._args: unknown[]) => undefined),
  attempts: 0,
}));

vi.mock('@main/store/worktree-transition-input-repo', () => ({
  worktreeTransitionInputRepo: {
    listPending: () => harness.pending.filter((input) => input.deliveredAt === null),
    markDelivered: (
      _sessionId: string,
      _generation: number,
      sequence: number,
      deliveredAt: number,
    ) => {
      const input = harness.pending.find((candidate) => candidate.sequence === sequence);
      if (!input || input.deliveredAt !== null) return false;
      input.deliveredAt = deliveredAt;
      return true;
    },
  },
}));

vi.mock('@main/store/worktree-transition-repo', () => ({
  worktreeTransitionRepo: {
    settleAfterInputDrain: () => {
      harness.attempts += 1;
      if (harness.attempts === 1) {
        harness.pending.push(queuedInput(2, 'late after snapshot'));
        return { settled: false, record: transition() };
      }
      return {
        settled: true,
        record: transition({ phase: 'active', toolUseId: null }),
      };
    },
    sealInputAfterDrain: vi.fn(),
  },
}));

import { settleTransitionInputs } from '../transition-delivery';

function transition(
  overrides: Partial<WorktreeTransitionRecord> = {},
): WorktreeTransitionRecord {
  return {
    sessionId: 'session-a',
    generation: 2,
    direction: 'enter',
    phase: 'switching_to_worktree',
    originalCwd: '/repo',
    targetCwd: '/repo/worktree',
    mainRepo: '/repo',
    worktreePath: '/repo/worktree',
    baseCommit: 'a'.repeat(40),
    toolUseId: 'tool-enter',
    continuationKey: 'cwd:test:2',
    continuationDelivered: true,
    discardChanges: false,
    requestedAt: 1,
    updatedAt: 1,
    lastError: null,
    ...overrides,
  };
}

function queuedInput(
  sequence: number,
  text: string,
): WorktreeTransitionQueuedInput {
  return {
    sessionId: 'session-a',
    generation: 2,
    sequence,
    agentId: 'codex-cli',
    text,
    attachments: [],
    createdAt: sequence,
    deliveredAt: null,
  };
}

beforeEach(() => {
  harness.pending = [queuedInput(1, 'first snapshot')];
  harness.enqueue.mockClear();
  harness.attempts = 0;
});

describe('worktree transition input delivery', () => {
  it('repeats delivery when an input arrives between the snapshot and atomic seal', async () => {
    const adapter = {
      id: 'codex-cli',
      enqueueMessage: harness.enqueue,
    } as unknown as AgentAdapter;

    const settled = await settleTransitionInputs(
      transition(),
      adapter,
      {
        kind: 'phase',
        expected: 'switching_to_worktree',
        next: 'active',
      },
      'input',
    );

    expect(harness.enqueue.mock.calls.map((call) => call[1])).toEqual([
      'first snapshot',
      'late after snapshot',
    ]);
    expect(harness.enqueue.mock.calls.map((call) => (
      call[3] as { idempotencyKey?: string } | undefined
    )?.idempotencyKey)).toEqual([
      'cwd:test:2:input:1',
      'cwd:test:2:input:2',
    ]);
    expect(harness.attempts).toBe(2);
    expect(settled).toMatchObject({ phase: 'active', toolUseId: null });
  });
});
