import { describe, expect, it, vi } from 'vitest';

import { makeInternalSession } from './types';
import {
  translateSdkMessageCore,
  type ClaudeSdkMessageTranslationHost,
} from './sdk-message-translate-core';

function host(): ClaudeSdkMessageTranslationHost & {
  now: ReturnType<typeof vi.fn>;
  runtimeMetadata: ClaudeSdkMessageTranslationHost['runtimeMetadata'] & {
    setModel: ReturnType<typeof vi.fn>;
    emitUpdated: ReturnType<typeof vi.fn>;
  };
  state: ClaudeSdkMessageTranslationHost['state'] & {
    setPermissionMode: ReturnType<typeof vi.fn>;
    publishUpdated: ReturnType<typeof vi.fn>;
  };
} {
  const records = new Map<string, { model?: string; permissionMode?: string }>([
    ['session-a', { model: 'old-model', permissionMode: 'default' }],
  ]);
  const runtimeMetadata = {
    read: (sessionId: string) => records.get(sessionId) ?? null,
    setModel: vi.fn((sessionId: string, model: string) => {
      records.set(sessionId, { ...records.get(sessionId), model });
    }),
    setEffort: vi.fn(),
    emitUpdated: vi.fn(),
    warnFailure: vi.fn(),
  };
  const state = {
    read: (sessionId: string) => records.get(sessionId) ?? null,
    setPermissionMode: vi.fn((sessionId: string, permissionMode: string) => {
      records.set(sessionId, { ...records.get(sessionId), permissionMode });
    }),
    publishUpdated: vi.fn(),
  };
  return {
    agentId: 'claude-core',
    now: vi.fn(() => 5150),
    runtimeMetadata,
    liveRate: {
      resolveModel: () => 'claude-opus-4-8',
      emitTokenRateTick: vi.fn(),
    },
    state,
  };
}

describe('Claude SDK message translator Core', () => {
  it('uses the injected identity and clock for translated assistant content', () => {
    const translationHost = host();
    const internal = makeInternalSession({
      cwd: '/workspace',
      applicationSid: 'session-a',
    });
    const emit = vi.fn();

    translateSdkMessageCore(
      emit,
      'session-a',
      {
        type: 'assistant',
        message: { content: [{ type: 'text', text: 'done' }] },
      },
      internal,
      translationHost,
    );

    expect(emit).toHaveBeenCalledWith({
      sessionId: 'session-a',
      agentId: 'claude-core',
      kind: 'message',
      payload: { text: 'done', role: 'assistant' },
      ts: 5150,
      source: 'sdk',
    });
  });

  it('routes init model and permission state through separate injected ports', () => {
    const translationHost = host();
    const internal = makeInternalSession({
      cwd: '/workspace',
      applicationSid: 'session-a',
      permissionMode: 'default',
    });

    translateSdkMessageCore(
      vi.fn(),
      'session-a',
      {
        type: 'system',
        subtype: 'init',
        model: 'claude-opus-4-8',
        permissionMode: 'plan',
      },
      internal,
      translationHost,
    );

    expect(internal.runtimeModel).toBe('claude-opus-4-8');
    expect(internal.permissionMode).toBe('plan');
    expect(translationHost.runtimeMetadata.setModel).toHaveBeenCalledWith(
      'session-a',
      'claude-opus-4-8',
    );
    expect(translationHost.runtimeMetadata.emitUpdated).toHaveBeenCalledWith('session-a');
    expect(translationHost.state.setPermissionMode).toHaveBeenCalledWith(
      'session-a',
      'plan',
    );
    expect(translationHost.state.publishUpdated).toHaveBeenCalledWith('session-a');
  });

  it('keeps expected-close results silent while clearing live-rate state', () => {
    const translationHost = host();
    const internal = makeInternalSession({
      cwd: '/workspace',
      applicationSid: 'session-a',
    });
    internal.expectedClose = true;
    internal.liveTokenEstimate = {
      bucketKey: 'claude-opus-4-8',
      estTokensSinceFlush: 1,
      lastFlushTs: 1,
      hasFlushAnchor: true,
      decodeElapsedMs: 10,
    };
    const emit = vi.fn();

    translateSdkMessageCore(
      emit,
      'session-a',
      { type: 'result', subtype: 'error_during_execution', is_error: true },
      internal,
      translationHost,
    );

    expect(emit).not.toHaveBeenCalled();
    expect(internal.liveTokenEstimate).toBeUndefined();
    expect(translationHost.liveRate.emitTokenRateTick).toHaveBeenCalledWith({
      sessionId: 'session-a',
      bucketKey: 'claude-opus-4-8',
      tps: 0,
      ts: 5150,
      done: true,
    });
  });
});
