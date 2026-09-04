import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  methods,
  RequestError,
  type SessionUpdate,
} from '@agentclientprotocol/sdk';
import { describe, expect, it, vi } from 'vitest';

import type { GrokAcpProcess } from '../acp-process';
import { GROK_SESSION_INFO_METHOD } from '../context-usage';
import { GrokTurnQueue } from '../turn-queue';
import { NOOP_GROK_BRIDGE_RUNTIME_HOST, type GrokBridgeRuntimeHost } from '../bridge-runtime-core';
import {
  negotiatedGrokSessionImageCapability,
  requireNativeSession,
} from '../turn-queue-helpers';
import type { GrokRuntime } from '../runtime-types';
import { createGrokTranslationState, translateGrokUpdate } from '../translate';

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
  };
}

function makeQueue(
  firstModelEventTimeoutMs?: number,
  beforeNextTurn?: (runtime: GrokRuntime) => Promise<void>,
  runtimeHost?: GrokBridgeRuntimeHost,
) {
  const events: Array<{ kind: string; payload: unknown }> = [];
  const emitError = vi.fn();
  const closeSession = vi.fn(async () => undefined);
  const recycleRuntime = vi.fn(async (runtime: GrokRuntime) => {
    runtime.ready = true;
    runtime.suppressUpdates = false;
  });
  const queue = new GrokTurnQueue({
    emit: (event) => events.push({ kind: event.kind, payload: event.payload }),
    emitEvent: (_sessionId, kind, payload) => events.push({ kind, payload }),
    emitError,
    closeSession,
    recycleRuntime,
    beforeNextTurn,
    runtimeHost,
    firstModelEventTimeoutMs,
  });
  return { queue, events, emitError, closeSession, recycleRuntime };
}

describe('GrokTurnQueue active-turn delivery', () => {
  it('applies staged runtime settings before claiming the next turn', async () => {
    const order: string[] = [];
    const request = vi.fn(async (method: string) => {
      if (method === methods.agent.session.prompt) order.push('prompt');
      return { stopReason: 'end_turn' as const, usage: undefined };
    });
    const runtime = makeRuntime(request);
    runtime.grokSandbox = 'strict';
    const boundary = deferred<void>();
    const beforeNextTurn = vi.fn(async (candidate: GrokRuntime) => {
      order.push('boundary');
      await boundary.promise;
      candidate.activeGrokSandbox = candidate.grokSandbox;
    });
    const { queue } = makeQueue(undefined, beforeNextTurn);

    queue.enqueue(runtime, 'use the staged sandbox');

    await vi.waitFor(() => expect(beforeNextTurn).toHaveBeenCalledOnce());
    expect(request).not.toHaveBeenCalledWith(
      methods.agent.session.prompt,
      expect.anything(),
      expect.anything(),
    );
    boundary.resolve();
    await vi.waitFor(() => expect(request).toHaveBeenCalledWith(
      methods.agent.session.prompt,
      expect.anything(),
      expect.anything(),
    ));
    expect(order.slice(0, 2)).toEqual(['boundary', 'prompt']);
    expect(runtime.activeGrokSandbox).toBe('strict');
  });

  it('refreshes the Browser context at the actual provider turn boundary', async () => {
    const request = vi.fn(async () => ({ stopReason: 'end_turn' as const, usage: undefined }));
    const runtime = makeRuntime(request);
    const refreshBrowserRuntime = vi.fn();
    const { queue } = makeQueue(undefined, undefined, {
      ...NOOP_GROK_BRIDGE_RUNTIME_HOST,
      refreshBrowserRuntime,
    });

    queue.enqueue(runtime, 'resume after an idle day');

    await vi.waitFor(() => expect(request).toHaveBeenCalled());
    expect(refreshBrowserRuntime).toHaveBeenCalledWith('app-session');
    expect(refreshBrowserRuntime.mock.invocationCallOrder[0]).toBeLessThan(
      request.mock.invocationCallOrder[0],
    );
  });

  it('keeps image negotiation bound to each live ACP runtime', () => {
    const disabled = makeRuntime(vi.fn());
    disabled.process!.initializeResponse.agentCapabilities = {
      promptCapabilities: { image: false },
    };
    const enabled = makeRuntime(vi.fn());

    expect(negotiatedGrokSessionImageCapability(disabled)).toBe(false);
    expect(negotiatedGrokSessionImageCapability(enabled)).toBe(true);
    expect(negotiatedGrokSessionImageCapability(undefined)).toBeNull();
    enabled.ready = false;
    expect(negotiatedGrokSessionImageCapability(enabled)).toBe(false);
  });

  it('sends providerText privately while persisting the public handoff text', async () => {
    const request = vi.fn(async (method: string) => {
      if (method === methods.agent.session.prompt) {
        return { stopReason: 'end_turn' as const, usage: undefined };
      }
      return { status: 'queued' };
    });
    const runtime = makeRuntime(request);
    const { queue, events } = makeQueue();

    queue.enqueue(runtime, 'persisted continuation instruction', undefined, {
      providerText: 'private continuation capsule',
    });

    await vi.waitFor(() => expect(request).toHaveBeenCalledWith(
      methods.agent.session.prompt,
      expect.objectContaining({
        prompt: [{ type: 'text', text: 'private continuation capsule' }],
      }),
      expect.objectContaining({ cancellationSignal: expect.any(AbortSignal) }),
    ));
    expect(events).toContainEqual({
      kind: 'message',
      payload: {
        text: 'persisted continuation instruction',
        role: 'user',
      },
    });
    expect(JSON.stringify(events)).not.toContain('private continuation capsule');
  });

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
        expect.objectContaining({ cancellationSignal: expect.any(AbortSignal) }),
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

  it('does not expose an already-rendered uncorrelated message as pending outgoing', async () => {
    const runtime = makeRuntime(vi.fn());
    runtime.ready = false;
    const { queue, events } = makeQueue();

    queue.enqueue(runtime, 'initial prompt');
    const internalMessageId = runtime.queue[0]!.id;

    expect(events).toContainEqual({
      kind: 'message',
      payload: {
        text: 'initial prompt',
        role: 'user',
      },
    });
    expect(queue.listPendingOutgoingMessages(runtime)).toEqual([]);
    await expect(
      queue.removePendingOutgoingMessage(runtime, internalMessageId),
    ).resolves.toBeNull();
    expect(runtime.queue.map((message) => message.text)).toEqual(['initial prompt']);

    queue.enqueue(runtime, 'renderer-deferred prompt', undefined, {
      deferUserEventUntilTurnStart: true,
      turnCorrelationId: 'renderer-pending-1',
    });
    expect(queue.listPendingOutgoingMessages(runtime)).toEqual([{
      id: 'renderer-pending-1',
      text: 'renderer-deferred prompt',
    }]);
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

  it('passes active-turn steer images through x.ai/interject', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'agent-deck-grok-'));
    const imagePath = join(directory, 'input.png');
    await writeFile(imagePath, Buffer.from([0, 1, 2, 3]));
    try {
      const request = vi.fn(async () => ({ status: 'queued' }));
      const runtime = makeRuntime(request);
      runtime.running = true;
      const { queue } = makeQueue();

      await queue.steer(runtime, 'look at this', [
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

  it('does not re-persist an already recorded deferred prompt on acceptance', async () => {
    const prompt = deferred<{ stopReason: 'end_turn'; usage: undefined }>();
    const request = vi.fn((method: string) => {
      if (method === methods.agent.session.prompt) return prompt.promise;
      return Promise.resolve({ status: 'cancelled' });
    });
    const runtime = makeRuntime(request);
    const { queue, events } = makeQueue();

    queue.enqueue(runtime, 'persisted before replay', undefined, {
      deferUserEventUntilTurnStart: true,
      userEventAlreadyPersisted: true,
      turnCorrelationId: 'grok-persisted-replay',
    });
    await vi.waitFor(() => expect(runtime.submittingMessage).not.toBeNull());
    queue.confirmPromptAccepted(runtime);

    expect(events).not.toContainEqual(expect.objectContaining({
      kind: 'message',
      payload: expect.objectContaining({ text: 'persisted before replay', role: 'user' }),
    }));
    prompt.resolve({ stopReason: 'end_turn', usage: undefined });
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

  it('uses exact Grok Build copy for queue and native-session errors', async () => {
    const runtime = makeRuntime(vi.fn());
    const { queue } = makeQueue();

    await expect(queue.steer(runtime, 'insert')).rejects.toThrow(
      'Grok Build 当前没有可插入内容的活动轮次。',
    );

    runtime.running = true;
    runtime.submittingMessage = {
      message: { id: 'pending-1', text: 'pending' },
      status: 'submitting',
      promptRequestIssued: true,
      kind: 'interject',
    };
    await expect(queue.steer(runtime, 'insert')).rejects.toThrow(
      '当前 Grok Build 消息仍在提交，请稍后再试。',
    );

    runtime.submittingMessage = null;
    runtime.interjectionSupported = false;
    await expect(queue.steer(runtime, 'insert')).rejects.toThrow(
      '当前 Grok Build 版本不支持活动轮次插入。',
    );

    runtime.running = false;
    runtime.closed = true;
    expect(() => queue.enqueue(runtime, 'closing')).toThrow(
      'Grok Build 会话 app-session 正在关闭。',
    );

    runtime.closed = false;
    runtime.nativeSessionId = null;
    expect(() => requireNativeSession(runtime)).toThrow(
      'Grok Build 会话 app-session 缺少原生会话 ID。',
    );

    const queuedRuntime = makeRuntime(vi.fn());
    queuedRuntime.ready = false;
    for (let index = 0; index < 20; index += 1) {
      queue.enqueue(queuedRuntime, `queued-${index}`);
    }
    expect(() => queue.enqueue(queuedRuntime, 'queue overflow')).toThrow(
      '待发送队列已堆积 20 条，请等待当前轮次完成。',
    );
  });

  it('uses exact Grok Build copy for image and turn failures', async () => {
    const failedRequest = vi.fn(async () => {
      throw new Error('provider unavailable');
    });
    const failedRuntime = makeRuntime(failedRequest);
    const { queue, emitError } = makeQueue();
    queue.enqueue(failedRuntime, 'fail this turn');
    await vi.waitFor(() =>
      expect(emitError).toHaveBeenCalledWith(
        'app-session',
        'Grok Build 轮次失败：provider unavailable',
      ),
    );

    const imageRuntime = makeRuntime(vi.fn());
    imageRuntime.process!.initializeResponse.agentCapabilities = {
      promptCapabilities: { image: false },
    };
    expect(() =>
      queue.enqueue(imageRuntime, 'inspect image', [
        {
          kind: 'uploaded',
          path: '/tmp/input.png',
          mime: 'image/png',
          bytes: 1,
        },
      ]),
    ).toThrow(
      '当前 Grok Build ACP 会话未声明图片输入能力。请升级 Grok Build；当 initialize 返回 image=true 后，Agent Deck 会自动开放附件。',
    );
  });

  it('classifies only structured native context rejection codes', async () => {
    const structuredRequest = vi.fn(async () => {
      throw new RequestError(-32_000, 'provider rejected prompt', {
        error: { code: 'context_length_exceeded' },
      });
    });
    const structuredRuntime = makeRuntime(structuredRequest);
    const structured = makeQueue();
    structured.queue.enqueue(structuredRuntime, 'too much structured input');
    await vi.waitFor(() => expect(structured.emitError).toHaveBeenCalledWith(
      'app-session',
      'Grok Build 轮次失败：provider rejected prompt',
      'context-window-exceeded',
    ));

    const textOnlyRequest = vi.fn(async () => {
      throw new RequestError(-32_000, 'context_length_exceeded', {
        error: { message: 'context_window_exceeded' },
      });
    });
    const textOnlyRuntime = makeRuntime(textOnlyRequest);
    const textOnly = makeQueue();
    textOnly.queue.enqueue(textOnlyRuntime, 'same words only');
    await vi.waitFor(() => expect(textOnly.emitError).toHaveBeenCalledWith(
      'app-session',
      'Grok Build 轮次失败：context_length_exceeded',
    ));
    expect(textOnly.emitError).not.toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      'context-window-exceeded',
    );
  });

  it('marks a structured native terminal context rejection', async () => {
    const request = vi.fn(async () => ({
      stopReason: 'model_context_window_exceeded',
      usage: null,
    }));
    const runtime = makeRuntime(request);
    const { queue, events } = makeQueue();

    queue.enqueue(runtime, 'too large');

    await vi.waitFor(() => expect(events).toContainEqual({
      kind: 'finished',
      payload: {
        ok: false,
        subtype: 'model_context_window_exceeded',
        failureReason: 'context-window-exceeded',
      },
    }));
  });

  it('flushes the assistant from live ACP prompt_complete when PromptResponse is lost', async () => {
    const prompt = deferred<{ stopReason: 'end_turn'; usage: undefined }>();
    const request = vi.fn((_method: string, _params: unknown) => prompt.promise);
    const runtime = makeRuntime(request);
    const { queue, events, closeSession } = makeQueue();

    queue.enqueue(runtime, 'finish on the live terminal');
    await vi.waitFor(() => expect(request).toHaveBeenCalledOnce());
    const params = request.mock.calls[0]![1] as {
      _meta: { turnId: number };
    };
    expect(params._meta.turnId).toEqual(expect.any(Number));

    const update: SessionUpdate = {
      sessionUpdate: 'agent_message_chunk',
      content: { type: 'text', text: 'Delivered over ACP' },
    };
    queue.observeModelActivity(runtime, update);
    expect(
      translateGrokUpdate(
        runtime.applicationSessionId,
        runtime.cwd,
        update,
        runtime.translation,
      ),
    ).toEqual([]);
    expect(runtime.translation.pendingText).not.toBeNull();

    queue.observePromptComplete(runtime, {
      sessionId: 'native-session',
      promptId: 'provider-prompt-1',
      stopReason: 'end_turn',
      agentResult: null,
      turnId: params._meta.turnId,
    });

    await vi.waitFor(() => expect(runtime.running).toBe(false));
    expect(events).toContainEqual({
      kind: 'message',
      payload: { text: 'Delivered over ACP', role: 'assistant' },
    });
    expect(events).toContainEqual({
      kind: 'finished',
      payload: { ok: true, subtype: 'end_turn' },
    });
    expect(closeSession).not.toHaveBeenCalled();

    prompt.resolve({ stopReason: 'end_turn', usage: undefined });
    await Promise.resolve();
    expect(events.filter((event) => event.kind === 'finished')).toHaveLength(1);
  });

  it('ignores a prompt_complete terminal for a different ACP turnId', async () => {
    const prompt = deferred<{ stopReason: 'end_turn'; usage: undefined }>();
    const request = vi.fn((_method: string, _params: unknown) => prompt.promise);
    const runtime = makeRuntime(request);
    const { queue, events } = makeQueue();

    queue.enqueue(runtime, 'keep the turn correlated');
    await vi.waitFor(() => expect(request).toHaveBeenCalledOnce());
    const params = request.mock.calls[0]![1] as {
      _meta: { turnId: number };
    };
    queue.observePromptComplete(runtime, {
      sessionId: 'native-session',
      stopReason: 'end_turn',
      turnId: params._meta.turnId + 1,
    });
    await Promise.resolve();
    expect(runtime.running).toBe(true);
    expect(events.some((event) => event.kind === 'finished')).toBe(false);

    prompt.resolve({ stopReason: 'end_turn', usage: undefined });
    await vi.waitFor(() => expect(runtime.running).toBe(false));
  });

  it('finishes and recycles from the live extension turn_completed terminal', async () => {
    let promptSignal: AbortSignal | undefined;
    const request = vi.fn((
      _method: string,
      _params: unknown,
      options?: { cancellationSignal?: AbortSignal },
    ) => {
      promptSignal = options?.cancellationSignal;
      return new Promise(() => undefined);
    });
    const runtime = makeRuntime(request);
    const { queue, events, recycleRuntime } = makeQueue();

    queue.enqueue(runtime, 'hit the real Grok terminal rail');
    await vi.waitFor(() => expect(request).toHaveBeenCalledOnce());
    queue.observePromptComplete(runtime, {
      sessionId: 'native-session',
      update: {
        sessionUpdate: 'turn_completed',
        prompt_id: 'provider-rate-limit',
        stop_reason: 'rate_limit',
      },
      _meta: { agentTimestampMs: Date.now() + 10 },
    });

    await vi.waitFor(() => expect(events).toContainEqual({
      kind: 'message',
      payload: {
        text: 'Grok Build 请求触发速率限制，请稍后重试。',
        role: 'assistant',
        error: true,
      },
    }));
    expect(events).toContainEqual({
      kind: 'finished',
      payload: { ok: false, subtype: 'rate_limit' },
    });
    expect(promptSignal?.aborted).toBe(true);
    expect(recycleRuntime).toHaveBeenCalledWith(runtime);
    await vi.waitFor(() => expect(runtime.running).toBe(false));
  });

  it('ignores a stale extension terminal from before the active turn', async () => {
    const prompt = deferred<{ stopReason: 'end_turn'; usage: undefined }>();
    const request = vi.fn(() => prompt.promise);
    const runtime = makeRuntime(request);
    const { queue, events } = makeQueue();

    queue.enqueue(runtime, 'keep stale history out');
    await vi.waitFor(() => expect(request).toHaveBeenCalledOnce());
    queue.observePromptComplete(runtime, {
      sessionId: 'native-session',
      update: {
        sessionUpdate: 'turn_completed',
        prompt_id: 'stale-provider-prompt',
        stop_reason: 'rate_limit',
      },
      _meta: { agentTimestampMs: 1 },
    });
    await Promise.resolve();
    expect(runtime.running).toBe(true);
    expect(events.some((event) => event.kind === 'finished')).toBe(false);

    prompt.resolve({ stopReason: 'end_turn', usage: undefined });
    await vi.waitFor(() => expect(runtime.running).toBe(false));
  });

  it('does not let a bare successful extension terminal discard a missing assistant', async () => {
    const prompt = deferred<{ stopReason: 'end_turn'; usage: undefined }>();
    const request = vi.fn(() => prompt.promise);
    const runtime = makeRuntime(request);
    const { queue, events } = makeQueue();

    queue.enqueue(runtime, 'preserve the missing assistant');
    await vi.waitFor(() => expect(request).toHaveBeenCalledOnce());
    queue.observePromptComplete(runtime, {
      sessionId: 'native-session',
      update: {
        sessionUpdate: 'turn_completed',
        prompt_id: 'provider-success-without-live-text',
        stop_reason: 'end_turn',
      },
      _meta: { agentTimestampMs: Date.now() + 10 },
    });

    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(runtime.running).toBe(true);
    expect(events.some((event) => event.kind === 'finished')).toBe(false);

    prompt.resolve({ stopReason: 'end_turn', usage: undefined });
    await vi.waitFor(() => expect(runtime.running).toBe(false));
  });

  it('recovers and recycles when Grok completes natively but every live ACP rail stalls', async () => {
    const root = await mkdtemp(join(tmpdir(), 'grok-native-recovery-'));
    const cwd = '/repo with spaces';
    const nativeSessionId = 'native-recovery';
    const historyDir = join(root, encodeURIComponent(cwd), nativeSessionId);
    await mkdir(historyDir, { recursive: true });
    let promptSignal: AbortSignal | undefined;
    const request = vi.fn((
      _method: string,
      _params: unknown,
      options?: { cancellationSignal?: AbortSignal },
    ) => {
      promptSignal = options?.cancellationSignal;
      return new Promise(() => undefined);
    });
    const runtime = makeRuntime(request);
    runtime.cwd = cwd;
    runtime.nativeSessionId = nativeSessionId;
    const events: Array<{ kind: string; payload: unknown }> = [];
    const recycleRuntime = vi.fn(async (candidate: GrokRuntime) => {
      candidate.ready = true;
      candidate.suppressUpdates = false;
    });
    const closeSession = vi.fn(async () => undefined);
    const queue = new GrokTurnQueue({
      emit: (event) => events.push({ kind: event.kind, payload: event.payload }),
      emitEvent: (_sessionId, kind, payload) => events.push({ kind, payload }),
      emitError: vi.fn(),
      closeSession,
      recycleRuntime,
      providerCompletionPollMs: 5,
      providerHistoryRoot: root,
    });

    try {
      queue.enqueue(runtime, 'recover this turn');
      await vi.waitFor(() => expect(request).toHaveBeenCalledOnce());
      const promptId = 'provider-prompt-1';
      const completedAt = Date.now() + 10;
      await writeFile(join(historyDir, 'updates.jsonl'), [
        JSON.stringify({
          method: 'session/update',
          params: {
            sessionId: nativeSessionId,
            update: {
              sessionUpdate: 'agent_message_chunk',
              content: { type: 'text', text: 'Recovered answer' },
            },
            _meta: { promptId, agentTimestampMs: completedAt - 1 },
          },
        }),
        JSON.stringify({
          method: '_x.ai/session_notification',
          params: {
            sessionId: nativeSessionId,
            update: {
              sessionUpdate: 'turn_completed',
              prompt_id: promptId,
              stop_reason: 'end_turn',
              usage: {
                inputTokens: 10,
                outputTokens: 3,
                totalTokens: 13,
                reasoningTokens: 2,
                cachedReadTokens: 0,
              },
            },
            _meta: { agentTimestampMs: completedAt },
          },
        }),
      ].join('\n'));

      await vi.waitFor(() => expect(events).toContainEqual({
        kind: 'message',
        payload: {
          text: 'Recovered answer',
          role: 'assistant',
          recoveredFrom: 'grok-native-history',
        },
      }));
      expect(events).toContainEqual(expect.objectContaining({
        kind: 'token-usage',
        payload: expect.objectContaining({
          messageId: promptId,
          reasoningTokens: 2,
          cacheReadTokens: 0,
        }),
      }));
      expect(events).toContainEqual({
        kind: 'finished',
        payload: {
          ok: true,
          subtype: 'end_turn',
          recoveredFrom: 'grok-native-history',
        },
      });
      expect(promptSignal?.aborted).toBe(true);
      expect(recycleRuntime).toHaveBeenCalledWith(runtime);
      expect(closeSession).not.toHaveBeenCalled();
      await vi.waitFor(() => expect(runtime.running).toBe(false));
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('uses exact usage from the live ACP PromptResponse metadata', async () => {
    const request = vi.fn(async () => ({
      stopReason: 'end_turn' as const,
      _meta: {
        sessionId: 'native-session',
        promptId: 'provider-prompt-usage',
        usage: {
          inputTokens: 17,
          outputTokens: 4,
          totalTokens: 21,
          reasoningTokens: 3,
          cachedReadTokens: 2,
        },
      },
    }));
    const runtime = makeRuntime(request);
    const { queue, events } = makeQueue();

    queue.enqueue(runtime, 'capture ACP usage');

    await vi.waitFor(() => expect(runtime.running).toBe(false));
    expect(events).toContainEqual({
      kind: 'token-usage',
      payload: expect.objectContaining({
        messageId: 'provider-prompt-usage',
        inputTokens: 17,
        outputTokens: 4,
        reasoningTokens: 3,
        cacheReadTokens: 2,
        cacheCreationTokens: null,
      }),
    });
  });

  it('actively refreshes current context after a completed turn', async () => {
    const request = vi.fn(async (method: string) => {
      if (method === methods.agent.session.prompt) {
        return { stopReason: 'end_turn' as const, usage: undefined };
      }
      if (method === GROK_SESSION_INFO_METHOD) {
        return {
          result: {
            context: { used: 9_658, total: 500_000, usagePct: 2 },
          },
        };
      }
      return {};
    });
    const runtime = makeRuntime(request);
    runtime.runtimeIdentity = { runtimeProvider: 'native', model: 'grok-4.5' };
    const { queue, events } = makeQueue();

    queue.enqueue(runtime, 'refresh context');

    await vi.waitFor(() => expect(events).toContainEqual({
      kind: 'context-usage',
      payload: {
        usedTokens: 9_658,
        windowTokens: 500_000,
        capacitySource: 'runtime-usage',
        runtimeIdentity: { runtimeProvider: 'native', model: 'grok-4.5' },
      },
    }));
    expect(request).toHaveBeenCalledWith(
      GROK_SESSION_INFO_METHOD,
      { sessionId: 'native-session' },
      expect.objectContaining({ cancellationSignal: expect.any(AbortSignal) }),
    );
  });

  it('surfaces and recycles a prompt with no first model event', async () => {
    const runtime = makeRuntime(vi.fn(() => new Promise(() => undefined)));
    const closeSession = vi.fn(async () => {
      runtime.closed = true;
    });
    const emitError = vi.fn();
    const queue = new GrokTurnQueue({
      emit: vi.fn(),
      emitEvent: vi.fn(),
      emitError,
      closeSession,
      recycleRuntime: vi.fn(async () => undefined),
      firstModelEventTimeoutMs: 5,
    });

    queue.enqueue(runtime, 'hang after acceptance');

    await vi.waitFor(() => expect(emitError).toHaveBeenCalledWith(
      'app-session',
      expect.stringContaining('Grok Build 已接受 prompt'),
    ));
    expect(closeSession).toHaveBeenCalledWith('app-session');
    expect(runtime.running).toBe(false);
  });

  it('uses exact Grok Build copy for interjection failures', async () => {
    const runtime = makeRuntime(vi.fn(async () => {
      throw new Error('interjection unavailable');
    }));
    runtime.running = true;
    const { queue, events } = makeQueue();

    await queue.send(runtime, 'insert');
    await vi.waitFor(() =>
      expect(events).toContainEqual({
        kind: 'message',
        payload: {
          text: '⚠ Grok Build 插入失败：interjection unavailable',
          error: true,
        },
      }),
    );

  });
});
