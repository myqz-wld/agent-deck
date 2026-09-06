import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentAdapter } from '@main/adapters/types';
import type { AgentEvent, UploadedAttachmentRef } from '@shared/types';
import type { WorktreeTransitionQueuedInput, WorktreeTransitionRecord } from '../types';

const harness = vi.hoisted(() => ({
  record: null as WorktreeTransitionRecord | null,
  pending: [] as WorktreeTransitionQueuedInput[],
}));

vi.mock('@main/store/db', () => ({ isDbInitialized: () => true }));
vi.mock('@main/store/worktree-transition-repo', () => ({
  worktreeTransitionRepo: {
    get: () => harness.record,
    markContinuationDelivered: () => { harness.record!.continuationDelivered = true; },
    settleAfterInputDrain: (input: { next: WorktreeTransitionRecord['phase'] }) => {
      if (harness.pending.some((entry) => entry.deliveredAt === null)) {
        return { settled: false, record: harness.record };
      }
      harness.record!.phase = input.next;
      harness.record!.toolUseId = null;
      return { settled: true, record: harness.record };
    },
  },
}));
vi.mock('@main/store/worktree-transition-input-repo', async (importOriginal) => ({
  ...await importOriginal<typeof import('@main/store/worktree-transition-input-repo')>(),
  worktreeTransitionInputRepo: {
    append: (input: Omit<WorktreeTransitionQueuedInput, 'sequence' | 'deliveredAt'>) => {
      const queued = { ...input, sequence: harness.pending.length + 1, deliveredAt: null };
      harness.pending.push(queued);
      return queued;
    },
    listPending: () => harness.pending.filter((entry) => entry.deliveredAt === null),
    markDelivered: (_sessionId: string, _generation: number, sequence: number, ts: number) => {
      harness.pending.find((entry) => entry.sequence === sequence)!.deliveredAt = ts;
      return true;
    },
  },
}));

import { guardHandOffSourceIngress } from '../../hand-off/ingress-guard';
import { WorktreeTransitionCoordinator } from '../coordinator';
import { deliverTransitionWork, toAgentCwdTransition } from '../transition-delivery';
import { WORKTREE_TRANSITION_CONTINUATION } from '../constants';
import { MessageController } from '@main/adapters/codex-cli/sdk-bridge/message-controller';
import { CodexCwdTransitionController } from '@main/adapters/codex-cli/sdk-bridge/cwd-transition-controller';
import { CodexPendingTurnQueue } from '@main/adapters/codex-cli/sdk-bridge/pending-turn-queue';
import type { InternalSession } from '@main/adapters/codex-cli/sdk-bridge/types';
import type { CodexBridgeRuntimeHost } from '@main/adapters/codex-cli/sdk-bridge/runtime-host-core';
import { sendClaudeMessageCore } from '@main/adapters/claude-code/sdk-bridge/message-controller-core';
import { GrokMessageController } from '@main/adapters/grok-build/message-controller';

const attachments: UploadedAttachmentRef[] = [{
  kind: 'uploaded', path: '/uploads/correction.png', mime: 'image/png', bytes: 5,
}];
const options = { deferUserEventUntilTurnStart: true, turnCorrelationId: 'outgoing-1' };

beforeEach(() => {
  harness.pending = [];
  harness.record = {
    sessionId: 'session-a', generation: 3, direction: 'enter', phase: 'interrupting_enter_turn',
    originalCwd: '/repo', targetCwd: '/repo/worktree', mainRepo: '/repo',
    worktreePath: '/repo/worktree', baseCommit: 'a'.repeat(40), toolUseId: 'tool-enter',
    continuationKey: 'cwd:test:3', continuationDelivered: false, discardChanges: false,
    requestedAt: 1, updatedAt: 1, lastError: null,
  };
});

function createCodex(emit: (event: AgentEvent) => void, session?: InternalSession) {
  const runTurnLoop = vi.fn(async () => undefined);
  const controller = new MessageController({
    sessions: new Map(session ? [['session-a', session]] : []),
    emit,
    runtimeHost: {
      guardHandOffSourceIngress,
      hasPendingWorktreeTransition: () => harness.record!.toolUseId !== null,
    } as unknown as CodexBridgeRuntimeHost,
    recoverAndSend: vi.fn(async () => { throw new Error('unexpected recovery'); }),
    runTurnLoop,
  });
  return { controller, runTurnLoop };
}

function historySink() {
  const history: AgentEvent[] = [];
  const coordinator = new WorktreeTransitionCoordinator();
  return {
    history,
    emit: (event: AgentEvent) => {
      if (coordinator.observe(event)) history.push(event);
    },
  };
}

describe('worktree buffered input continuity', () => {
  it.each(['codex-cli', 'claude-code', 'grok-build'] as const)(
    'keeps %s send and enqueue acknowledgements visible through the shared interruption fence',
    async (agentId) => {
      const { history, emit } = historySink();
      const unexpectedDispatch = vi.fn(async () => { throw new Error('old runtime received input'); });
      if (agentId === 'codex-cli') {
        const { controller, runTurnLoop } = createCodex(emit);
        await controller.sendMessage('session-a', 'correction', attachments, options);
        await controller.enqueueMessage('session-a', 'follow-up', [], { ...options, turnCorrelationId: 'outgoing-2' });
        expect(runTurnLoop).not.toHaveBeenCalled();
      } else if (agentId === 'claude-code') {
        const context = {
          sessions: new Map(), emit, recoverAndSend: unexpectedDispatch, makeUserMessage: vi.fn(),
        };
        const host = { guardSourceIngress: guardHandOffSourceIngress, acceptedEnqueueEventFailed: vi.fn(), now: Date.now };
        await sendClaudeMessageCore(context, {
          sessionId: 'session-a', text: 'correction', attachments, enqueueOptions: options,
        }, host);
        await sendClaudeMessageCore(context, {
          sessionId: 'session-a', text: 'follow-up', allowQueueOverflow: true,
          enqueueOptions: { ...options, turnCorrelationId: 'outgoing-2' },
        }, host);
      } else {
        const controller = new GrokMessageController({
          runtimeHost: {
            guardHandOffSourceIngress: (input) => guardHandOffSourceIngress({ ...input, agentId }),
            hasPendingWorktreeTransition: () => true,
          },
          emit, dispatch: unexpectedDispatch, steer: unexpectedDispatch,
        });
        await controller.sendMessage('session-a', 'correction', attachments, options);
        await controller.enqueueMessage('session-a', 'follow-up', [], { ...options, turnCorrelationId: 'outgoing-2' });
      }
      expect(unexpectedDispatch).not.toHaveBeenCalled();
      expect(harness.pending.map((entry) => entry.text)).toEqual(['correction', 'follow-up']);
      expect(history).toHaveLength(2);
      expect(history[0]).toMatchObject({
        agentId, kind: 'message', payload: {
          role: 'user', text: 'correction', attachments, turnCorrelationId: 'outgoing-1',
        },
      });
      expect(history[1]).toMatchObject({ payload: { turnCorrelationId: 'outgoing-2' } });
    },
  );

  it.each(['enter', 'exit'] as const)(
    'replays interrupted %s input once behind the continuation at the target cwd',
    async (direction) => {
      const record = harness.record!;
      record.direction = direction;
      record.phase = direction === 'enter' ? 'interrupting_enter_turn' : 'interrupting_exit_turn';
      record.targetCwd = direction === 'enter' ? record.worktreePath : record.originalCwd;
      const transition = toAgentCwdTransition(record);
      const session = {
        applicationSid: 'session-a', threadId: 'native-a', cwd: transition.fromCwd,
        thread: { updateWorkingDirectory: vi.fn() }, pendingTurns: new CodexPendingTurnQueue(),
        currentTurn: null, currentTurnId: null, turnLoopRunning: true, intentionallyClosed: false,
      } as unknown as InternalSession;
      const { history, emit } = historySink();
      const { controller, runTurnLoop } = createCodex(emit, session);
      const cwdController = new CodexCwdTransitionController({
        sessions: new Map([['session-a', session]]), runTurnLoop,
      });
      cwdController.arm(transition);
      await controller.sendMessage('session-a', 'correction', attachments, options);
      await controller.sendMessage('session-a', 'follow-up', [], { ...options, turnCorrelationId: 'outgoing-2' });
      expect(session.pendingTurns.length).toBe(0);

      // The old turn has now stopped. Replay uses the same adapter and shared ingress as sends.
      cwdController.switchCwd(transition);
      record.phase = direction === 'enter' ? 'switching_to_worktree' : 'cleanup_pending';
      const enqueue = vi.fn(controller.enqueueMessage.bind(controller));
      const adapter = {
        id: 'codex-cli', enqueueMessage: enqueue,
        enqueueCwdTransitionContinuation: async (...args) => cwdController.enqueueContinuation(...args),
      } satisfies Partial<AgentAdapter>;
      await deliverTransitionWork(record, adapter as unknown as AgentAdapter, transition, false, {
        kind: 'phase', expected: record.phase, next: direction === 'enter' ? 'active' : 'cleared',
      });

      expect(harness.pending.every((input) => input.deliveredAt !== null)).toBe(true);
      expect(session.thread.updateWorkingDirectory).toHaveBeenCalledWith(record.targetCwd);
      expect([...session.pendingTurns].map((entry) => entry.handOffMessage?.text ?? entry.input))
        .toEqual([WORKTREE_TRANSITION_CONTINUATION, 'correction', 'follow-up']);
      expect(session.pendingTurns.at(1)?.handOffMessage?.attachments).toEqual(attachments);
      expect(history).toHaveLength(2);
      expect(enqueue).toHaveBeenCalledTimes(2);
      expect(runTurnLoop).not.toHaveBeenCalled();
      session.turnLoopRunning = false;
      cwdController.release('session-a', record.generation);
      expect(runTurnLoop).toHaveBeenCalledOnce();
      expect(session.cwd).toBe(record.targetCwd);
    },
  );
});
