import type { Query } from '@anthropic-ai/claude-agent-sdk';
import { describe, expect, it, vi } from 'vitest';
import {
  ClaudeStreamProcessorCore,
  type ClaudeStreamProcessorHost,
} from './stream-processor-core';
import { makeInternalSession } from './types';

function queryFrom(generator: () => AsyncGenerator<unknown>): Query {
  return {
    [Symbol.asyncIterator]: generator,
    interrupt: vi.fn(() => Promise.resolve()),
  } as unknown as Query;
}

function host(): ClaudeStreamProcessorHost & {
  warn: ReturnType<typeof vi.fn>;
  finalize: ClaudeStreamProcessorHost['finalize'] & {
    releaseSdkClaim: ReturnType<typeof vi.fn>;
  };
  identity: ClaudeStreamProcessorHost['identity'] & {
    renameSdkSession: ReturnType<typeof vi.fn>;
  };
} {
  const now = () => 7_000;
  return {
    agentId: 'claude-core',
    now,
    warn: vi.fn(),
    userMessages: {
      readAttachmentBase64: vi.fn(() => Promise.resolve('base64')),
      createProviderMessageId: () => 'provider-message-id',
      now,
    },
    translation: {
      agentId: 'claude-core',
      now,
      runtimeMetadata: {
        read: () => null,
        setModel: vi.fn(),
        setEffort: vi.fn(),
        emitUpdated: vi.fn(),
        warnFailure: vi.fn(),
      },
      liveRate: {
        resolveModel: () => null,
        emitTokenRateTick: vi.fn(),
      },
      state: {
        read: () => null,
        setPermissionMode: vi.fn(),
        publishUpdated: vi.fn(),
      },
    },
    finalize: {
      agentId: 'claude-core',
      now,
      resolveModel: () => null,
      emitTokenRateTick: vi.fn(),
      releaseSdkClaim: vi.fn(),
    },
    identity: {
      warn: vi.fn(),
      renameSdkSession: vi.fn(),
      updateCliSessionId: vi.fn(),
    },
  };
}

describe('Claude stream processor Core', () => {
  it('adopts the first provider id, translates content, and finalizes exact ownership', async () => {
    const internal = makeInternalSession({ cwd: '/workspace', applicationSid: 'temp-sid' });
    internal.query = queryFrom(async function* () {
      yield {
        type: 'assistant',
        session_id: 'provider-sid',
        message: { content: [{ type: 'text', text: 'hello from Core' }] },
      };
    });
    const sessions = new Map([['temp-sid', internal]]);
    const emit = vi.fn();
    const ports = host();
    const firstId = vi.fn();
    const processor = new ClaudeStreamProcessorCore({ sessions, emit }, ports);

    await expect(processor.consume(internal, 'temp-sid', firstId)).resolves.toBe(
      'provider-sid',
    );

    expect(firstId).toHaveBeenCalledWith('provider-sid');
    expect(ports.identity.renameSdkSession).toHaveBeenCalledWith(
      'temp-sid',
      'provider-sid',
    );
    expect(emit).toHaveBeenCalledWith({
      sessionId: 'provider-sid',
      agentId: 'claude-core',
      kind: 'message',
      payload: { text: 'hello from Core', role: 'assistant' },
      ts: 7_000,
      source: 'sdk',
    });
    expect(emit).toHaveBeenCalledWith(expect.objectContaining({
      sessionId: 'provider-sid',
      kind: 'session-end',
    }));
    expect(sessions.size).toBe(0);
    expect(ports.finalize.releaseSdkClaim).toHaveBeenCalledWith('provider-sid');
    await expect(internal.streamDrained).resolves.toBeUndefined();
  });

  it('projects unexpected provider failures and still completes the final barrier', async () => {
    const internal = makeInternalSession({ cwd: '/workspace', applicationSid: 'session-a' });
    internal.query = queryFrom(async function* () {
      throw new Error('provider exploded');
    });
    const sessions = new Map([['session-a', internal]]);
    const emit = vi.fn();
    const ports = host();
    const processor = new ClaudeStreamProcessorCore({ sessions, emit }, ports);

    await expect(processor.consume(internal, 'session-a', vi.fn())).resolves.toBeNull();

    expect(ports.warn).toHaveBeenCalledWith(
      '[sdk-bridge] query loop ended',
      expect.objectContaining({ message: 'provider exploded' }),
    );
    expect(emit).toHaveBeenCalledWith({
      sessionId: 'session-a',
      agentId: 'claude-core',
      kind: 'message',
      payload: { text: '⚠ SDK 流中断：provider exploded', error: true },
      ts: 7_000,
      source: 'sdk',
    });
    expect(emit).toHaveBeenCalledWith(expect.objectContaining({ kind: 'session-end' }));
    expect(sessions.size).toBe(0);
    await expect(internal.streamDrained).resolves.toBeUndefined();
  });
});
