import { describe, expect, it, vi } from 'vitest';
import type { AgentEvent } from '@shared/types';
import { handOffCutoverCoordinator } from '@main/session/hand-off/cutover-coordinator';
import { MessageController } from '../message-controller';
import { MAX_PENDING_MESSAGES } from '../constants';
import type { InternalSession } from '../types';

function internal(sessionId: string): InternalSession {
  return {
    applicationSid: sessionId,
    threadId: sessionId,
    cwd: '/repo',
    thread: {},
    pendingMessages: [],
    currentTurn: null,
    currentTurnId: null,
    turnLoopRunning: true,
    intentionallyClosed: false,
  } as unknown as InternalSession;
}

describe('MessageController handoff rollback recovery', () => {
  it('allows mandatory successor tails past ordinary pending queue backpressure', async () => {
    const sessionId = 'codex-successor-overflow';
    const session = internal(sessionId);
    session.pendingMessages = Array.from(
      { length: MAX_PENDING_MESSAGES },
      (_, index) => `existing-${index}`,
    );
    const controller = new MessageController({
      sessions: new Map([[sessionId, session]]),
      emit: vi.fn(),
      recoverAndSend: vi.fn(async () => undefined),
      runTurnLoop: vi.fn(async () => undefined),
    });

    await controller.enqueueMessage(
      sessionId,
      'mandatory handoff tail',
      undefined,
      { bypassQueueLimit: true },
    );

    expect(session.pendingMessages).toHaveLength(MAX_PENDING_MESSAGES + 1);
    expect(session.pendingHandOffMessages?.at(-1)).toEqual(
      expect.objectContaining({ text: 'mandatory handoff tail' }),
    );
  });

  it('buffers enqueueMessage during a chained handoff and replays it only on rollback', async () => {
    const sessionId = 'codex-chained-handoff-source';
    const session = internal(sessionId);
    const emit = vi.fn<(event: AgentEvent) => void>();
    const controller = new MessageController({
      sessions: new Map([[sessionId, session]]),
      emit,
      recoverAndSend: vi.fn(async () => undefined),
      runTurnLoop: vi.fn(async () => undefined),
    });
    const lease = handOffCutoverCoordinator.tryAcquire(sessionId)!;

    await controller.enqueueMessage(sessionId, 'redirected from an older owner');
    expect(session.pendingMessages).toEqual([]);
    expect(emit).toHaveBeenCalledTimes(1);

    lease.release();
    await vi.waitFor(() => {
      expect(session.pendingMessages).toEqual(['redirected from an older owner']);
    });
    expect(emit).toHaveBeenCalledTimes(1);
  });

  it('queues after missing-session recovery without emitting the persisted user event twice', async () => {
    const sessionId = 'codex-handoff-missing-source';
    const sessions = new Map<string, InternalSession>();
    const recovered = internal('codex-recovered-source');
    const emit = vi.fn<(event: AgentEvent) => void>();
    const recoverAndSend = vi.fn(async (
      _sid: string,
      _text: string,
      _attachments: unknown,
      options?: { sendAfterRecovery?: (sessionId: string) => Promise<void> },
    ) => {
      sessions.set(recovered.applicationSid, recovered);
      await options?.sendAfterRecovery?.(recovered.applicationSid);
    });
    const controller = new MessageController({
      sessions,
      emit,
      recoverAndSend,
      runTurnLoop: vi.fn(async () => undefined),
    });
    const lease = handOffCutoverCoordinator.tryAcquire(sessionId)!;

    await controller.sendMessage(sessionId, 'persisted before recovery');
    expect(emit).toHaveBeenCalledTimes(1);
    expect(recoverAndSend).not.toHaveBeenCalled();

    lease.release();
    await vi.waitFor(() => {
      expect(recovered.pendingMessages).toEqual(['persisted before recovery']);
    });
    expect(recoverAndSend).toHaveBeenCalledWith(
      sessionId,
      'persisted before recovery',
      undefined,
      expect.objectContaining({
        userEventAlreadyPersisted: true,
        sendAfterRecovery: expect.any(Function),
      }),
    );
    expect(emit).toHaveBeenCalledTimes(1);
  });
});
