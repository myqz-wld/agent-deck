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
  const notify = vi.fn(async () => undefined);
  return {
    applicationSessionId: 'app-session',
    nativeSessionId: 'native-session',
    cwd: '/repo',
    process: {
      connection: { agent: { request, notify } },
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
    grokSandbox: null,
    restartingSandbox: false,
    agentProfileName: null,
    agentProfileSource: null,
    agentPluginDir: null,
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

    await vi.waitFor(() => expect(request).toHaveBeenCalledWith(
      '_x.ai/interject',
      expect.objectContaining({
        sessionId: 'native-session',
        text: 'insert now',
        interjectionId: expect.any(String),
        content: [{ type: 'text', text: 'insert now' }],
      }),
      expect.objectContaining({ cancellationSignal: expect.any(AbortSignal) }),
    ));
    expect(runtime.queue).toEqual([]);
    await vi.waitFor(() => expect(events).toContainEqual({
      kind: 'message',
      payload: {
        text: 'insert now',
        role: 'user',
        steer: true,
        turnCorrelationId: 'correlation-1',
      },
    }));

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

    await vi.waitFor(() => expect(runtime.interjectionSupported).toBe(false));
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

      await vi.waitFor(() => expect(request).toHaveBeenCalledWith(
        '_x.ai/interject',
        expect.objectContaining({
        content: [
          { type: 'text', text: 'look at this' },
          {
            type: 'image',
            data: 'AAECAw==',
            mimeType: 'image/png',
            uri: expect.stringContaining('input.png'),
          },
        ],
        }),
        expect.objectContaining({ cancellationSignal: expect.any(AbortSignal) }),
      ));
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('waits for ACP user echo before displaying a queued message and supports cancellation', async () => {
    const prompt = deferred<{ stopReason: 'end_turn'; usage: undefined }>();
    const request = vi.fn((method: string) => {
      if (method === methods.agent.session.prompt) return prompt.promise;
      return Promise.resolve({ status: 'cancelled' });
    });
    const runtime = makeRuntime(request);
    const { queue, events } = makeQueue();

    queue.enqueue(runtime, 'queued until accepted', undefined, {
      deferUserEventUntilTurnStart: true,
      turnCorrelationId: 'grok-queued-1',
    });
    await vi.waitFor(() => expect(runtime.submittingMessage).not.toBeNull());
    expect(events).not.toContainEqual(expect.objectContaining({
      payload: expect.objectContaining({ text: 'queued until accepted' }),
    }));
    expect(queue.listPendingOutgoingMessages(runtime).map((message) => message.id))
      .toEqual(['grok-queued-1']);

    queue.confirmPromptAccepted(runtime);
    expect(events).toContainEqual({
      kind: 'message',
      payload: {
        text: 'queued until accepted',
        role: 'user',
        turnCorrelationId: 'grok-queued-1',
      },
    });
    prompt.resolve({ stopReason: 'end_turn', usage: undefined });
    await vi.waitFor(() => expect(runtime.running).toBe(false));

    const secondPrompt = deferred<{ stopReason: 'end_turn'; usage: undefined }>();
    request.mockImplementation((method: string) => {
      if (method === methods.agent.session.prompt) return secondPrompt.promise;
      return Promise.resolve({ status: 'cancelled' });
    });
    queue.enqueue(runtime, 'cancel before echo', undefined, {
      deferUserEventUntilTurnStart: true,
      turnCorrelationId: 'grok-cancel-1',
    });
    await vi.waitFor(() => expect(runtime.submittingMessage).not.toBeNull());
    const pending = queue.listPendingOutgoingMessages(runtime);
    await expect(queue.removePendingOutgoingMessage(runtime, pending[0]!.id)).resolves.toMatchObject({
      id: 'grok-cancel-1',
    });
    expect(events).not.toContainEqual(expect.objectContaining({
      payload: expect.objectContaining({ text: 'cancel before echo' }),
    }));
    secondPrompt.resolve({ stopReason: 'end_turn', usage: undefined });
    await vi.waitFor(() => expect(runtime.running).toBe(false));
  });

  it('keeps an active interjection pending until accepted and cancels only that request', async () => {
    const interject = deferred<{ status: 'queued' }>();
    let cancellationSignal: AbortSignal | undefined;
    const request = vi.fn((method: string, _params: unknown, options?: { cancellationSignal?: AbortSignal }) => {
      if (method === '_x.ai/interject') {
        cancellationSignal = options?.cancellationSignal;
        return interject.promise;
      }
      return Promise.resolve({ status: 'queued' });
    });
    const runtime = makeRuntime(request);
    runtime.running = true;
    const { queue, events } = makeQueue();

    await queue.send(runtime, 'cancel this interjection', undefined, {
      deferUserEventUntilTurnStart: true,
      turnCorrelationId: 'grok-interject-1',
    });
    await vi.waitFor(() => expect(cancellationSignal).toBeDefined());
    expect(queue.listPendingOutgoingMessages(runtime).map((message) => message.id))
      .toEqual(['grok-interject-1']);

    await expect(queue.removePendingOutgoingMessage(runtime, 'grok-interject-1'))
      .resolves.toMatchObject({ id: 'grok-interject-1' });
    expect(cancellationSignal?.aborted).toBe(true);
    expect(queue.listPendingOutgoingMessages(runtime)).toEqual([]);

    interject.resolve({ status: 'queued' });
    await Promise.resolve();
    expect(events).not.toContainEqual(expect.objectContaining({
      payload: expect.objectContaining({ text: 'cancel this interjection' }),
    }));
  });
});
