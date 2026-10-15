import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AgentEvent } from '@shared/types';
import { readMessageDeliveryRecovery } from '@shared/message-delivery-recovery';
import { ClaudeCodeAdapter, type ClaudeCodeAdapterHost } from '../adapter-core';
import { ClaudeSdkBridge } from '../sdk-bridge';
import { makeInternalSession, type InternalSession, type SdkBridgeOptions } from '../sdk-bridge/types';
import { createClaudeUserMessageStreamCore } from '../sdk-bridge/user-message-stream-core';
import { confirmClaudeUserMessageAcceptanceCore } from '../sdk-bridge/user-message-acceptance-core';
import { finishClaudeUserMessageInterruptionCore } from '../sdk-bridge/user-message-interruption-core';
import { preserveClaudeStreamInputsCore } from '../sdk-bridge/user-message-recovery-core';

const firstId = '11111111-1111-4111-8111-111111111111';
const secondId = '22222222-2222-4222-8222-222222222222';
const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});

function fixture(running = true) {
  const internal = makeInternalSession({ cwd: '/workspace', applicationSid: 'receiver' });
  internal.userTurnInFlight = running;
  const emit = vi.fn<(event: AgentEvent) => void>();
  const now = () => 100;
  const inputHost = {
    now, createProviderMessageId: () => 'unexpected-generated-id',
    readAttachmentBase64: async () => '',
  };
  const bridge = new ClaudeSdkBridge({
    emit,
    restartSessionHost: { subscribeRenames: () => vi.fn(), warn: vi.fn() },
    messageControllerHost: {
      guardSourceIngress: () => false, acceptedEnqueueEventFailed: vi.fn(), now,
    },
    streamProcessorHost: { userMessages: inputHost },
  } as unknown as SdkBridgeOptions);
  const { sessions } = bridge as unknown as { sessions: Map<string, InternalSession> };
  sessions.set('receiver', internal);
  const adapter = new ClaudeCodeAdapter({} as ClaudeCodeAdapterHost);
  (adapter as unknown as { bridge: ClaudeSdkBridge }).bridge = bridge;
  const stream = createClaudeUserMessageStreamCore({ sessions, emit }, internal, inputHost)
    [Symbol.asyncIterator]();
  cleanups.push(async () => {
    internal.providerInputClosed = true;
    internal.notify?.();
    await stream.return?.();
  });
  const body = (id: string) => `[from Teammate @ grok-build][msg ${id}][sid sender]\nUse the latest result`;
  const send = (id: string) => adapter.receiveTeammateMessage('receiver', 'sender', body(id), id);
  const accept = (id: string) => confirmClaudeUserMessageAcceptanceCore(
    emit, 'receiver', { type: 'user', uuid: id, parent_tool_use_id: null },
    internal, { agentId: 'claude-code', now },
  );
  return { internal, emit, stream, body, send, accept, now };
}

describe('Claude teammate delivery through the adapter and SDK input stream', () => {
  it.each([false, true])('delivers the wire message with priority now (running=%s)', async (running) => {
    const f = fixture(running);
    const next = f.stream.next();
    await f.send(firstId);

    await vi.waitFor(() => expect(f.internal.submittingUserMessage?.providerMessageId).toBe(firstId));
    await expect(next).resolves.toMatchObject({ value: {
      type: 'user', priority: 'now', uuid: firstId, session_id: 'receiver',
      message: { role: 'user', content: f.body(firstId) },
    } });
    expect(f.emit).not.toHaveBeenCalled();
    expect(f.internal.midTurnUserMessageIds?.has(firstId) ?? false).toBe(running);

    f.accept(firstId);
    f.accept(firstId);
    expect(f.emit).toHaveBeenCalledOnce();
    expect(f.emit).toHaveBeenCalledWith(expect.objectContaining({ payload: {
      role: 'user', text: f.body(firstId), turnCorrelationId: firstId,
    } }));
  });

  it('delivers consecutive messages before the turn ends and deduplicates retries', async () => {
    const f = fixture();
    const first = f.stream.next();
    await f.send(firstId);
    await vi.waitFor(() => expect(f.internal.submittingUserMessage?.providerMessageId).toBe(firstId));
    await first;
    await f.send(firstId);
    await f.send(secondId);
    const next = f.stream.next();
    await vi.waitFor(() => expect(f.internal.notify).not.toBeNull());
    expect(f.internal.pendingUserMessages).toHaveLength(1);

    f.accept(firstId);
    await expect(next).resolves.toMatchObject({ value: { uuid: secondId, priority: 'now' } });
    f.accept(secondId);
    await f.send(firstId);
    await f.send(secondId);

    expect(f.internal.userTurnInFlight).toBe(true);
    expect(f.internal.pendingUserMessages).toEqual([]);
    expect(f.emit.mock.calls.map(([event]) => event.payload)).toEqual([
      expect.objectContaining({ turnCorrelationId: firstId }),
      expect.objectContaining({ turnCorrelationId: secondId }),
    ]);
    expect([...f.internal.midTurnUserMessageIds!]).toEqual([firstId, secondId]);
  });

  it('recognizes the preempted turn without hiding failures of the teammate input itself', async () => {
    const f = fixture();
    const next = f.stream.next();
    await f.send(firstId);
    await vi.waitFor(() => expect(f.internal.submittingUserMessage?.providerMessageId).toBe(firstId));
    await next;
    f.accept(firstId);
    const result = {
      subtype: 'error_during_execution', is_error: true, terminal_reason: 'aborted_streaming',
      user_message_uuid: 'original',
      errors: ['[ede_diagnostic] result_type=user last_content_type=n/a stop_reason=null'],
    };

    expect(finishClaudeUserMessageInterruptionCore(f.internal, result)).toBe(true);
    expect(finishClaudeUserMessageInterruptionCore(f.internal, {
      ...result, user_message_uuid: firstId,
    })).toBe(false);
    expect(f.internal.midTurnUserMessageIds?.size).toBe(0);
  });

  it('retains unacknowledged and unsent teammate messages after stream loss', async () => {
    const f = fixture();
    const next = f.stream.next();
    await f.send(firstId);
    await vi.waitFor(() => expect(f.internal.submittingUserMessage?.providerMessageId).toBe(firstId));
    await next;
    await f.send(secondId);

    preserveClaudeStreamInputsCore(f.emit, f.internal, { agentId: 'claude-code', now: f.now });

    const recovered = f.emit.mock.calls.map(([event]) => readMessageDeliveryRecovery(event));
    expect(recovered).toEqual([
      expect.objectContaining({ messageId: firstId, text: f.body(firstId), status: 'unknown' }),
      expect.objectContaining({ messageId: secondId, text: f.body(secondId), status: 'not-sent' }),
    ]);
    expect(f.internal.submittingUserMessage).toBeNull();
    expect(f.internal.pendingUserMessages).toEqual([]);
  });

  it('retains the worktree transition gate before immediate delivery', async () => {
    const f = fixture();
    f.internal.cwdTransitionGeneration = 1;
    const next = f.stream.next();
    await f.send(firstId);
    expect(f.internal.submittingUserMessage).toBeNull();
    expect(f.internal.pendingUserMessages).toHaveLength(1);

    f.internal.cwdTransitionGeneration = null;
    f.internal.notify?.();
    await vi.waitFor(() => expect(f.internal.submittingUserMessage?.providerMessageId).toBe(firstId));
    await expect(next).resolves.toMatchObject({ value: { uuid: firstId } });
  });
});
