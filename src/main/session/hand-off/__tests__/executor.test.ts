import { describe, expect, it, vi } from 'vitest';
import type { CreateSessionOptions } from '@main/adapters/types';
import type { SessionRecord } from '@shared/types';
import type { TrustedContinuationInitialTurn } from '../../continuation-context/initial-turn';
import { executePreparedHandOff, HandOffExecutionError } from '../executor';
import {
  HandOffLateMessageDeliveryError,
  type DeliverHandOffLateMessagesInput,
} from '../late-message-delivery';
import type { HandOffSourceCutoverResult } from '../source-precondition';
import { HandOffCutoverCoordinator } from '../cutover-coordinator';

const source: SessionRecord = {
  id: 'source', agentId: 'claude-code', cwd: '/repo', title: 'source', source: 'sdk',
  lifecycle: 'active', activity: 'idle', startedAt: 1, lastEventAt: 1,
  endedAt: null, archivedAt: null,
};
const target = { agentId: 'codex-cli', cwd: '/repo' } as CreateSessionOptions;
const turn = { kind: 'trusted-continuation' } as TrustedContinuationInitialTurn;
const sourcePrecondition = {
  eventRevision: 7,
  rebuildAfterRevision: 2,
  maxEventId: 42,
  runtimeFingerprint: 'source-runtime-v1',
};

function matchingSource() {
  return {
    ok: true as const,
    currentEventRevision: 7,
    compatibleEventRows: 0,
    lateMessages: [],
  };
}

describe('executePreparedHandOff', () => {
  it('propagates successor startup failure before cutover, transfer, or source finalization', async () => {
    const sourcePreconditionCheck = vi.fn();
    const transferResources = vi.fn();
    const closeSuccessor = vi.fn();
    const finalizeSource = vi.fn();

    await expect(
      executePreparedHandOff({
        source,
        sourcePrecondition,
        sourcePreconditionCheck,
        target,
        turn,
        createSuccessor: vi.fn(async () => {
          throw new Error('Codex startup failed before thread.started');
        }),
        transferResources,
        resourceTransferFailed: vi.fn(),
        closeSuccessor,
        finalizeSource,
      }),
    ).rejects.toThrow(/Codex startup failed/);

    expect(sourcePreconditionCheck).not.toHaveBeenCalled();
    expect(transferResources).not.toHaveBeenCalled();
    expect(closeSuccessor).not.toHaveBeenCalled();
    expect(finalizeSource).not.toHaveBeenCalled();
  });

  it('creates, transfers, then finalizes in strict order', async () => {
    const order: string[] = [];
    const result = await executePreparedHandOff({
      source,
      sourcePrecondition,
      sourcePreconditionCheck: matchingSource,
      target,
      turn,
      createSuccessor: vi.fn(async () => { order.push('create'); return 'successor'; }),
      sourceOwnershipCheck: vi.fn(() => {
        order.push('guard');
        return true;
      }),
      transferResources: vi.fn(() => { order.push('transfer'); return { failed: false }; }),
      resourceTransferFailed: (value: { failed: boolean }) => value.failed,
      commitIngress: vi.fn(() => { order.push('commit'); }),
      closeSuccessor: vi.fn(async () => { order.push('cleanup'); }),
      finalizeSource: vi.fn(async () => { order.push('finalize'); return 'closed'; }),
    });

    expect(order).toEqual(['create', 'guard', 'guard', 'transfer', 'commit', 'finalize']);
    expect(result).toEqual({
      successorSessionId: 'successor',
      queuedMessagesDelivered: 0,
      resourceTransfer: { failed: false },
      sourceCutover: {
        ok: true,
        currentEventRevision: 7,
        compatibleEventRows: 0,
        lateMessages: [],
      },
      sourceFinalization: { ok: true, value: 'closed' },
    });
  });

  it('queues pre-cutover provider input before scanning post-capture late messages', async () => {
    const deliveryOrder: string[] = [];
    const late = {
      eventId: 51,
      text: 'arrived after capture',
      attachments: [],
      origin: 'user' as const,
    };
    const sourcePreconditionCheck = vi
      .fn<() => HandOffSourceCutoverResult>()
      .mockReturnValueOnce({
        ok: true,
        currentEventRevision: 8,
        compatibleEventRows: 1,
        lateMessages: [late],
      })
      .mockReturnValue({
        ok: true,
        currentEventRevision: 8,
        compatibleEventRows: 1,
        lateMessages: [late],
      });
    const deliverLateMessages = vi.fn(async ({ messages }: DeliverHandOffLateMessagesInput) => {
      deliveryOrder.push(messages.map((message) => message.text).join(','));
      return [];
    });

    const result = await executePreparedHandOff({
      source,
      queuedMessages: [{ text: 'already queued on source' }],
      sourcePrecondition,
      sourcePreconditionCheck,
      target,
      turn,
      createSuccessor: vi.fn(async () => 'successor-with-queued-input'),
      deliverLateMessages,
      transferResources: vi.fn(() => ({ failed: false })),
      resourceTransferFailed: (value: { failed: boolean }) => value.failed,
      closeSuccessor: vi.fn(),
      finalizeSource: vi.fn(),
    });

    expect(deliveryOrder).toEqual(['already queued on source', 'arrived after capture']);
    expect(result.queuedMessagesDelivered).toBe(1);
  });

  it('closes an orphan on mandatory-transfer failure and never finalizes the source', async () => {
    const closeSuccessor = vi.fn(async () => undefined);
    const finalizeSource = vi.fn();
    const work = executePreparedHandOff({
      source,
      sourcePrecondition,
      sourcePreconditionCheck: matchingSource,
      target,
      turn,
      createSuccessor: vi.fn(async () => 'orphan'),
      transferResources: vi.fn(() => ({ failed: true })),
      resourceTransferFailed: (value: { failed: boolean }) => value.failed,
      closeSuccessor,
      finalizeSource,
    });

    await expect(work).rejects.toMatchObject({
      name: 'HandOffExecutionError',
      stage: 'transfer',
      successorSessionId: 'orphan',
      successorCleanup: 'ok',
      resourceTransfer: { failed: true },
      transferError: null,
    } satisfies Partial<HandOffExecutionError<{ failed: boolean }>>);
    expect(closeSuccessor).toHaveBeenCalledWith('orphan');
    expect(finalizeSource).not.toHaveBeenCalled();
  });

  it('closes an orphan and preserves explicit detail when resource transfer throws', async () => {
    const closeSuccessor = vi.fn(async () => undefined);
    const finalizeSource = vi.fn();
    const work = executePreparedHandOff({
      source,
      sourcePrecondition,
      sourcePreconditionCheck: matchingSource,
      target,
      turn,
      createSuccessor: vi.fn(async () => 'orphan-after-throw'),
      transferResources: vi.fn(() => {
        throw new Error('transfer transaction aborted');
      }),
      resourceTransferFailed: (value: { failed: boolean }) => value.failed,
      closeSuccessor,
      finalizeSource,
    });

    await expect(work).rejects.toMatchObject({
      name: 'HandOffExecutionError',
      stage: 'transfer',
      successorSessionId: 'orphan-after-throw',
      successorCleanup: 'ok',
      resourceTransfer: null,
      transferError: 'transfer transaction aborted',
    } satisfies Partial<HandOffExecutionError<{ failed: boolean }>>);
    expect(closeSuccessor).toHaveBeenCalledWith('orphan-after-throw');
    expect(finalizeSource).not.toHaveBeenCalled();
  });

  it('returns a source-finalization failure without invalidating the transferred successor', async () => {
    const closeSuccessor = vi.fn();
    const result = await executePreparedHandOff({
      source,
      sourcePrecondition,
      sourcePreconditionCheck: matchingSource,
      target,
      turn,
      createSuccessor: vi.fn(async () => 'successor'),
      transferResources: vi.fn(() => ({ failed: false })),
      resourceTransferFailed: (value: { failed: boolean }) => value.failed,
      closeSuccessor,
      finalizeSource: vi.fn(async () => { throw new Error('source close failed'); }),
    });

    expect(result.sourceFinalization).toEqual({ ok: false, error: 'source close failed' });
    expect(closeSuccessor).not.toHaveBeenCalled();
  });

  it('commits ingress before awaiting asynchronous source finalization', async () => {
    const coordinator = new HandOffCutoverCoordinator();
    const lease = coordinator.tryAcquire(source.id)!;
    let finishFinalization!: () => void;
    const finalization = new Promise<void>((resolve) => {
      finishFinalization = resolve;
    });
    const work = executePreparedHandOff({
      source,
      sourcePrecondition,
      sourcePreconditionCheck: matchingSource,
      target,
      turn,
      createSuccessor: vi.fn(async () => 'successor-during-finalize'),
      transferResources: vi.fn(() => ({ failed: false })),
      resourceTransferFailed: (value: { failed: boolean }) => value.failed,
      commitIngress: (successorSessionId) => lease.commit(successorSessionId),
      closeSuccessor: vi.fn(),
      finalizeSource: vi.fn(async () => finalization),
    });

    await vi.waitFor(() => {
      expect(coordinator.successorFor(source.id)).toBe('successor-during-finalize');
    });
    expect(coordinator.tryBufferInput(source.id, {
      record: vi.fn(),
      replay: vi.fn(async () => undefined),
    })).toBe(false);

    finishFinalization();
    await expect(work).resolves.toMatchObject({ successorSessionId: 'successor-during-finalize' });
    lease.release();
  });

  it('accepts a compatible append-only source advance after successor creation', async () => {
    const result = await executePreparedHandOff({
      source,
      sourcePrecondition,
      sourcePreconditionCheck: () => ({
        ok: true,
        currentEventRevision: 11,
        compatibleEventRows: 4,
        lateMessages: [],
      }),
      target,
      turn,
      createSuccessor: vi.fn(async () => 'successor-after-append'),
      transferResources: vi.fn(() => ({ failed: false })),
      resourceTransferFailed: (value: { failed: boolean }) => value.failed,
      closeSuccessor: vi.fn(),
      finalizeSource: vi.fn(async () => 'closed'),
    });

    expect(result.sourceCutover).toEqual({
      ok: true,
      currentEventRevision: 11,
      compatibleEventRows: 4,
      lateMessages: [],
    });
  });

  it('queues every late source input once and rescans until delivery is quiescent', async () => {
    const first = {
      eventId: 51,
      text: 'first late input',
      attachments: [],
      origin: 'user' as const,
    };
    const second = {
      eventId: 52,
      text: 'second late input',
      attachments: [],
      origin: 'cross-session' as const,
    };
    const sourcePreconditionCheck = vi
      .fn<() => HandOffSourceCutoverResult>()
      .mockReturnValueOnce({
        ok: true,
        currentEventRevision: 8,
        compatibleEventRows: 1,
        lateMessages: [first],
      })
      .mockReturnValueOnce({
        ok: true,
        currentEventRevision: 9,
        compatibleEventRows: 2,
        lateMessages: [first, second],
      })
      .mockReturnValue({
        ok: true,
        currentEventRevision: 9,
        compatibleEventRows: 2,
        lateMessages: [first, second],
      });
    const order: string[] = [];
    const deliverLateMessages = vi.fn(async ({ messages }: DeliverHandOffLateMessagesInput) => {
      order.push(`deliver:${messages.map((message) => message.eventId).join(',')}`);
      return [];
    });

    const result = await executePreparedHandOff({
      source,
      sourcePrecondition,
      sourcePreconditionCheck,
      target,
      turn,
      createSuccessor: vi.fn(async () => 'successor-with-tail'),
      deliverLateMessages,
      transferResources: vi.fn(() => {
        order.push('transfer');
        return { failed: false };
      }),
      resourceTransferFailed: (value: { failed: boolean }) => value.failed,
      closeSuccessor: vi.fn(),
      finalizeSource: vi.fn(() => {
        order.push('finalize');
        return 'closed';
      }),
    });

    expect(order).toEqual(['deliver:51', 'deliver:52', 'transfer', 'finalize']);
    expect(deliverLateMessages).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ successorSessionId: 'successor-with-tail', messages: [first] }),
    );
    expect(deliverLateMessages).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ successorSessionId: 'successor-with-tail', messages: [second] }),
    );
    expect(sourcePreconditionCheck).toHaveBeenCalledTimes(3);
    expect(result.sourceCutover).toMatchObject({
      currentEventRevision: 9,
      lateMessages: [first, second],
    });
  });

  it('accepts exactly eight delivery batches once the ninth scan is quiescent', async () => {
    const messages = Array.from({ length: 8 }, (_, index) => ({
      eventId: 100 + index,
      text: `late-${index + 1}`,
      attachments: [],
      origin: 'user' as const,
    }));
    let scan = 0;
    const sourcePreconditionCheck = vi.fn(() => {
      scan += 1;
      const count = Math.min(scan, messages.length);
      return {
        ok: true as const,
        currentEventRevision: 7 + count,
        compatibleEventRows: count,
        lateMessages: messages.slice(0, count),
      };
    });
    const deliverLateMessages = vi.fn(async () => []);

    await expect(executePreparedHandOff({
      source,
      sourcePrecondition,
      sourcePreconditionCheck,
      target,
      turn,
      createSuccessor: vi.fn(async () => 'successor-after-eight-batches'),
      deliverLateMessages,
      transferResources: vi.fn(() => ({ failed: false })),
      resourceTransferFailed: (value: { failed: boolean }) => value.failed,
      closeSuccessor: vi.fn(),
      finalizeSource: vi.fn(async () => 'closed'),
    })).resolves.toMatchObject({ successorSessionId: 'successor-after-eight-batches' });

    expect(deliverLateMessages).toHaveBeenCalledTimes(8);
    expect(sourcePreconditionCheck).toHaveBeenCalledTimes(9);
  });

  it('stops when a ninth delivery batch would be required', async () => {
    let scan = 0;
    const sourcePreconditionCheck = vi.fn(() => {
      scan += 1;
      return {
        ok: true as const,
        currentEventRevision: 7 + scan,
        compatibleEventRows: scan,
        lateMessages: Array.from({ length: scan }, (_, index) => ({
          eventId: 200 + index,
          text: `still-changing-${index + 1}`,
          attachments: [],
          origin: 'user' as const,
        })),
      };
    });
    const deliverLateMessages = vi.fn(async () => []);

    await expect(executePreparedHandOff({
      source,
      sourcePrecondition,
      sourcePreconditionCheck,
      target,
      turn,
      createSuccessor: vi.fn(async () => 'never-quiescent-successor'),
      deliverLateMessages,
      transferResources: vi.fn(() => ({ failed: false })),
      resourceTransferFailed: (value: { failed: boolean }) => value.failed,
      closeSuccessor: vi.fn(async () => undefined),
      finalizeSource: vi.fn(),
    })).rejects.toMatchObject({
      stage: 'cutover',
      cutoverReason: 'source-kept-changing',
    });

    expect(deliverLateMessages).toHaveBeenCalledTimes(8);
    expect(sourcePreconditionCheck).toHaveBeenCalledTimes(9);
  });

  it('closes the orphan and leaves resources untouched when late-message delivery fails', async () => {
    const cleanupOrder: string[] = [];
    const clonedAttachment = {
      kind: 'uploaded' as const,
      path: '/uploads/cloned.png',
      mime: 'image/png',
      bytes: 10,
    };
    const closeSuccessor = vi.fn(async () => {
      cleanupOrder.push('close');
    });
    const cleanupLateMessageAttachments = vi.fn(async () => {
      cleanupOrder.push('cleanup');
    });
    const transferResources = vi.fn();
    const finalizeSource = vi.fn();
    const work = executePreparedHandOff({
      source,
      sourcePrecondition,
      sourcePreconditionCheck: () => ({
        ok: true,
        currentEventRevision: 8,
        compatibleEventRows: 1,
        lateMessages: [{
          eventId: 51,
          text: 'must survive',
          attachments: [],
          origin: 'user',
        }],
      }),
      target,
      turn,
      createSuccessor: vi.fn(async () => 'orphan-with-undelivered-tail'),
      deliverLateMessages: vi.fn(async () => {
        throw new HandOffLateMessageDeliveryError(
          'target queue unavailable',
          [clonedAttachment],
        );
      }),
      cleanupLateMessageAttachments,
      transferResources,
      resourceTransferFailed: vi.fn(),
      closeSuccessor,
      finalizeSource,
    });

    await expect(work).rejects.toMatchObject({
      name: 'HandOffExecutionError',
      stage: 'cutover',
      successorSessionId: 'orphan-with-undelivered-tail',
      successorCleanup: 'ok',
      transferError: 'target queue unavailable',
      cutoverReason: 'late-message-delivery-failed',
    });
    expect(closeSuccessor).toHaveBeenCalledWith('orphan-with-undelivered-tail');
    expect(cleanupLateMessageAttachments).toHaveBeenCalledWith([clonedAttachment]);
    expect(cleanupOrder).toEqual(['close', 'cleanup']);
    expect(transferResources).not.toHaveBeenCalled();
    expect(finalizeSource).not.toHaveBeenCalled();
  });

  it('aborts before transfer when source ingress ownership is revoked during successor creation', async () => {
    const transferResources = vi.fn(() => ({ failed: false }));
    const commitIngress = vi.fn();
    const closeSuccessor = vi.fn(async () => undefined);

    await expect(executePreparedHandOff({
      source,
      sourcePrecondition,
      sourcePreconditionCheck: matchingSource,
      sourceOwnershipCheck: () => false,
      target,
      turn,
      createSuccessor: vi.fn(async () => 'revoked-orphan'),
      transferResources,
      resourceTransferFailed: (value: { failed: boolean }) => value.failed,
      commitIngress,
      closeSuccessor,
      finalizeSource: vi.fn(),
    })).rejects.toMatchObject({
      stage: 'cutover',
      successorSessionId: 'revoked-orphan',
      cutoverReason: 'source-not-open',
    });

    expect(closeSuccessor).toHaveBeenCalledWith('revoked-orphan');
    expect(transferResources).not.toHaveBeenCalled();
    expect(commitIngress).not.toHaveBeenCalled();
  });

  it('cleans clones from successful delivery passes when a later transfer fails', async () => {
    const clonedAttachment = {
      kind: 'uploaded' as const,
      path: '/uploads/clone-from-successful-pass.png',
      mime: 'image/png',
      bytes: 10,
    };
    const lateMessage = {
      eventId: 61,
      text: 'late message with a clone',
      attachments: [],
      origin: 'user' as const,
    };
    const sourcePreconditionCheck = vi
      .fn<() => HandOffSourceCutoverResult>()
      .mockReturnValueOnce({
        ok: true,
        currentEventRevision: 8,
        compatibleEventRows: 1,
        lateMessages: [lateMessage],
      })
      .mockReturnValue({
        ok: true,
        currentEventRevision: 8,
        compatibleEventRows: 1,
        lateMessages: [lateMessage],
      });
    const closeSuccessor = vi.fn(async () => undefined);
    const cleanupLateMessageAttachments = vi.fn(async () => undefined);

    await expect(executePreparedHandOff({
      source,
      sourcePrecondition,
      sourcePreconditionCheck,
      target,
      turn,
      createSuccessor: vi.fn(async () => 'orphan-after-clone'),
      deliverLateMessages: vi.fn(async () => [clonedAttachment]),
      cleanupLateMessageAttachments,
      transferResources: vi.fn(() => ({ failed: true })),
      resourceTransferFailed: (value: { failed: boolean }) => value.failed,
      closeSuccessor,
      finalizeSource: vi.fn(),
    })).rejects.toMatchObject({ stage: 'transfer' });

    expect(closeSuccessor).toHaveBeenCalledWith('orphan-after-clone');
    expect(cleanupLateMessageAttachments).toHaveBeenCalledWith([clonedAttachment]);
    expect(closeSuccessor.mock.invocationCallOrder[0])
      .toBeLessThan(cleanupLateMessageAttachments.mock.invocationCallOrder[0]!);
  });

  it.each([
    ['captured event mutation', 'captured-event-mutated'],
    ['rebuild epoch', 'rebuild-epoch-changed'],
    ['runtime', 'runtime-changed'],
  ] as const)('closes the orphan and moves no resources when %s is rejected during successor creation', async (
    _kind,
    reason,
  ) => {
    let finishCreate!: (sessionId: string) => void;
    let signalCreateStarted!: () => void;
    const createStarted = new Promise<void>((resolve) => {
      signalCreateStarted = resolve;
    });
    let currentResult: HandOffSourceCutoverResult = matchingSource();
    const closeSuccessor = vi.fn(async () => undefined);
    const transferResources = vi.fn(() => ({ failed: false }));
    const finalizeSource = vi.fn();
    const work = executePreparedHandOff({
      source,
      sourcePrecondition,
      sourcePreconditionCheck: () => currentResult,
      target,
      turn,
      createSuccessor: vi.fn(
        () =>
          new Promise<string>((resolve) => {
            finishCreate = resolve;
            signalCreateStarted();
          }),
      ),
      transferResources,
      resourceTransferFailed: (value: { failed: boolean }) => value.failed,
      closeSuccessor,
      finalizeSource,
    });

    await createStarted;
    currentResult = { ok: false, reason, currentEventRevision: 8 };
    finishCreate('stale-orphan');

    await expect(work).rejects.toMatchObject({
      name: 'HandOffExecutionError',
      stage: 'cutover',
      successorSessionId: 'stale-orphan',
      successorCleanup: 'ok',
      resourceTransfer: null,
      cutoverReason: reason,
    });
    expect(closeSuccessor).toHaveBeenCalledWith('stale-orphan');
    expect(transferResources).not.toHaveBeenCalled();
    expect(finalizeSource).not.toHaveBeenCalled();
  });
});
