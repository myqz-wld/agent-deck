import { methods, type SessionUpdate } from '@agentclientprotocol/sdk';
import { describe, expect, it, vi } from 'vitest';

import type { GrokAcpProcess } from './acp-process';
import type { GrokRuntime } from './runtime-types';
import { GrokTurnQueue } from './turn-queue';
import { createGrokTranslationState, translateGrokUpdate } from './translate';

function deferred<T>(): { promise: Promise<T>; resolve(value: T): void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((nextResolve) => {
    resolve = nextResolve;
  });
  return { promise, resolve };
}

function runtime(request: ReturnType<typeof vi.fn>): GrokRuntime {
  return {
    applicationSessionId: 'app-session',
    nativeSessionId: 'native-session',
    cwd: '/repo',
    process: {
      connection: { agent: { request, notify: vi.fn(async () => undefined) } },
      initializeResponse: { agentCapabilities: { promptCapabilities: { image: false } } },
    } as unknown as GrokAcpProcess,
    ready: true,
    queue: [],
    running: false,
    interjectionSupported: null,
    sealed: false,
    closed: false,
    disposed: false,
    suppressUpdates: false,
    model: 'gpt-56-sol',
    runtimeIdentity: null,
    thinking: null,
    sessionMode: null,
    grokSandbox: null,
    activeGrokSandbox: null,
    restartingSandbox: false,
    agentProfileName: null,
    agentProfileSource: null,
    agentPluginDir: null,
    pendingPermissions: new Map(),
    acceptedEnqueueFingerprints: new Map(),
    translation: createGrokTranslationState(),
    availableCommands: [{
      name: 'clear',
      description: 'clear context',
      argumentHint: '',
      aliases: ['reset'],
    }, {
      name: 'review',
      description: 'review changes',
      argumentHint: '',
      aliases: [],
    }],
  };
}

function queueHarness() {
  const events: Array<{ kind: string; payload: unknown }> = [];
  const emitError = vi.fn();
  const queue = new GrokTurnQueue({
    emit: (event) => events.push({ kind: event.kind, payload: event.payload }),
    emitEvent: (_sessionId, kind, payload) => events.push({ kind, payload }),
    emitError,
    closeSession: vi.fn(async () => undefined),
    recycleRuntime: vi.fn(async () => undefined),
  });
  return { emitError, events, queue };
}

describe('Grok session command feedback', () => {
  it('emits one final system message for a silent dynamic command', async () => {
    const request = vi.fn(async (method: string) =>
      method === methods.agent.session.prompt
        ? { stopReason: 'end_turn' as const, usage: undefined }
        : {});
    const active = runtime(request);
    const { emitError, events, queue } = queueHarness();

    queue.enqueue(active, '/reset now');
    await vi.waitFor(() => expect(active.running).toBe(false));

    expect(events.slice(-2).map((event) => event.kind)).toEqual(['message', 'finished']);
    expect(events).toContainEqual({
      kind: 'finished',
      payload: { ok: true, subtype: 'end_turn' },
    });
    expect(events).toContainEqual({
      kind: 'message',
      payload: {
        role: 'system',
        text: 'Grok Build /clear 已完成',
        sessionCommandStatus: { command: 'clear', status: 'completed' },
      },
    });
    expect(emitError).not.toHaveBeenCalled();
  });

  it('does not add feedback when the command produces an assistant reply', async () => {
    const prompt = deferred<{ stopReason: 'end_turn'; usage: undefined }>();
    const request = vi.fn((method: string) =>
      method === methods.agent.session.prompt ? prompt.promise : Promise.resolve({}));
    const active = runtime(request);
    const { events, queue } = queueHarness();

    queue.enqueue(active, '/review');
    await vi.waitFor(() => expect(request).toHaveBeenCalled());
    const update: SessionUpdate = {
      sessionUpdate: 'agent_message_chunk',
      content: { type: 'text', text: 'Review complete' },
    };
    queue.observeModelActivity(active, update);
    translateGrokUpdate(
      active.applicationSessionId,
      active.cwd,
      update,
      active.translation,
    );
    prompt.resolve({ stopReason: 'end_turn', usage: undefined });
    await vi.waitFor(() => expect(active.running).toBe(false));

    expect(events.slice(-2).map((event) => event.kind)).toEqual(['message', 'finished']);
    expect(events).toContainEqual({
      kind: 'message',
      payload: { text: 'Review complete', role: 'assistant' },
    });
    expect(events.some((event) =>
      (event.payload as { sessionCommandStatus?: unknown })?.sessionCommandStatus,
    )).toBe(false);
  });

  it('uses one final system failure instead of an assistant error', async () => {
    const request = vi.fn(async () => {
      throw new Error('native command failed');
    });
    const active = runtime(request);
    const { emitError, events, queue } = queueHarness();

    queue.enqueue(active, '/clear');
    await vi.waitFor(() => expect(active.running).toBe(false));

    expect(events).toContainEqual({
      kind: 'message',
      payload: {
        role: 'system',
        text: 'Grok Build /clear 失败：native command failed',
        error: true,
        sessionCommandStatus: { command: 'clear', status: 'failed' },
      },
    });
    expect(events).toContainEqual({
      kind: 'finished',
      payload: { ok: false, subtype: 'error' },
    });
    expect(emitError).not.toHaveBeenCalled();
  });
});
