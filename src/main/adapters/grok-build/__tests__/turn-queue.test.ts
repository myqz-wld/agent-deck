import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { methods } from '@agentclientprotocol/sdk';
import { describe, expect, it, vi } from 'vitest';

import type { GrokAcpProcess } from '../acp-process';
import { GrokTurnQueue } from '../turn-queue';
import type { GrokRuntime } from '../runtime-types';
import { createGrokTranslationState } from '../translate';

function deferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
} {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((nextResolve) => {
    resolve = nextResolve;
  });
  return { promise, resolve };
}

function makeRuntime(request: ReturnType<typeof vi.fn>): GrokRuntime {
  return {
    applicationSessionId: 'app-session',
    nativeSessionId: 'native-session',
    cwd: '/repo',
    process: {
      connection: { agent: { request } },
      initializeResponse: {
        agentCapabilities: { promptCapabilities: { image: true } },
      },
    } as unknown as GrokAcpProcess,
    ready: true,
    queue: [],
    running: false,
    interjectionSupported: null,
    sealed: false,
    closed: false,
    disposed: false,
    suppressUpdates: false,
    model: 'fake-model',
    thinking: null,
    sessionMode: null,
    agentProfileName: null,
    pendingPermissions: new Map(),
    acceptedEnqueueFingerprints: new Map(),
    translation: createGrokTranslationState(),
  };
}

function makeQueue() {
  const events: Array<{ kind: string; payload: unknown }> = [];
  const queue = new GrokTurnQueue({
    emit: (event) => events.push({ kind: event.kind, payload: event.payload }),
    emitEvent: (_sessionId, kind, payload) => events.push({ kind, payload }),
    emitError: vi.fn(),
    closeSession: vi.fn(async () => undefined),
  });
  return { queue, events };
}

describe('GrokTurnQueue active-turn delivery', () => {
  it('uses x.ai/interject for ordinary input while a prompt is running', async () => {
    const prompt = deferred<{ stopReason: 'end_turn'; usage: undefined }>();
    const request = vi.fn((method: string) => {
      if (method === methods.agent.session.prompt) return prompt.promise;
      return Promise.resolve({ status: 'queued' });
    });
    const runtime = makeRuntime(request);
    const { queue, events } = makeQueue();

    queue.enqueue(runtime, 'first');
    await vi.waitFor(() => {
      expect(request).toHaveBeenCalledWith(
        methods.agent.session.prompt,
        expect.objectContaining({ sessionId: 'native-session' }),
      );
    });

    await queue.send(runtime, 'insert now', undefined, {
      deferUserEventUntilTurnStart: true,
      turnCorrelationId: 'correlation-1',
    });

    expect(request).toHaveBeenCalledWith('_x.ai/interject', {
      sessionId: 'native-session',
      text: 'insert now',
      interjectionId: expect.any(String),
      content: [{ type: 'text', text: 'insert now' }],
    });
    expect(runtime.queue).toEqual([]);
    expect(events).toContainEqual({
      kind: 'message',
      payload: {
        text: 'insert now',
        role: 'user',
        steer: true,
        turnCorrelationId: 'correlation-1',
      },
    });

    prompt.resolve({ stopReason: 'end_turn', usage: undefined });
    await vi.waitFor(() => expect(runtime.running).toBe(false));
    expect(
      request.mock.calls.filter(([method]) => method === methods.agent.session.prompt),
    ).toHaveLength(1);
  });

  it('keeps enqueueMessage-style delivery behind the active turn', async () => {
    const firstPrompt = deferred<{ stopReason: 'end_turn'; usage: undefined }>();
    const secondPrompt = deferred<{ stopReason: 'end_turn'; usage: undefined }>();
    let promptCount = 0;
    const request = vi.fn((method: string) => {
      if (method === methods.agent.session.prompt) {
        promptCount += 1;
        return promptCount === 1 ? firstPrompt.promise : secondPrompt.promise;
      }
      return Promise.resolve({ status: 'queued' });
    });
    const runtime = makeRuntime(request);
    const { queue } = makeQueue();

    queue.enqueue(runtime, 'first');
    await vi.waitFor(() => expect(runtime.running).toBe(true));
    queue.enqueue(runtime, 'after current turn');

    expect(runtime.queue).toHaveLength(1);
    expect(request).not.toHaveBeenCalledWith('_x.ai/interject', expect.anything());

    firstPrompt.resolve({ stopReason: 'end_turn', usage: undefined });
    await vi.waitFor(() => expect(promptCount).toBe(2));
    secondPrompt.resolve({ stopReason: 'end_turn', usage: undefined });
    await vi.waitFor(() => expect(runtime.running).toBe(false));
  });

  it('falls back to the FIFO queue when the extension is unavailable', async () => {
    const request = vi.fn((method: string) => {
      if (method === '_x.ai/interject') {
        return Promise.reject(Object.assign(new Error('Method not found'), { code: -32601 }));
      }
      return Promise.resolve({ stopReason: 'end_turn', usage: undefined });
    });
    const runtime = makeRuntime(request);
    runtime.running = true;
    const { queue, events } = makeQueue();

    await queue.send(runtime, 'queue fallback', undefined, {
      deferUserEventUntilTurnStart: true,
      turnCorrelationId: 'correlation-2',
    });

    expect(runtime.interjectionSupported).toBe(false);
    expect(runtime.queue).toHaveLength(1);
    expect(events).not.toContainEqual(expect.objectContaining({
      payload: expect.objectContaining({ text: 'queue fallback' }),
    }));
  });

  it('passes image content through x.ai/interject', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'agent-deck-grok-'));
    const imagePath = join(directory, 'input.png');
    await writeFile(imagePath, Buffer.from([0, 1, 2, 3]));
    try {
      const request = vi.fn(async () => ({ status: 'queued' }));
      const runtime = makeRuntime(request);
      runtime.running = true;
      const { queue } = makeQueue();

      await queue.send(runtime, 'look at this', [
        { kind: 'uploaded', path: imagePath, mime: 'image/png', bytes: 4 },
      ]);

      expect(request).toHaveBeenCalledWith('_x.ai/interject', expect.objectContaining({
        content: [
          { type: 'text', text: 'look at this' },
          {
            type: 'image',
            data: 'AAECAw==',
            mimeType: 'image/png',
            uri: expect.stringContaining('input.png'),
          },
        ],
      }));
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
