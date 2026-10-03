import { describe, expect, it, vi } from 'vitest';
import type { GrokAcpSession } from '../acp-process';
import { createGrokRuntime } from '../runtime-factory';
import { GrokTurnQueue } from '../turn-queue';

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

function fixture(request = vi.fn(async (..._args: unknown[]) => ({ status: 'queued' }))) {
  const runtime = createGrokRuntime('app-session', { cwd: '/workspace', prompt: '' }, null);
  runtime.nativeSessionId = 'native-session';
  runtime.process = {
    connection: { agent: { request, notify: vi.fn() } },
    initializeResponse: { agentCapabilities: { promptCapabilities: { image: true } } },
  } as unknown as GrokAcpSession;
  runtime.ready = true;
  runtime.running = true;
  const emitEvent = vi.fn();
  const queue = new GrokTurnQueue({
    emit: vi.fn(), emitEvent, emitError: vi.fn(),
    closeSession: vi.fn(async () => {}), recycleRuntime: vi.fn(async () => {}),
  });
  const send = (text: string) => queue.send(runtime, text, undefined, {
    deferUserEventUntilTurnStart: true, turnCorrelationId: text,
  });
  const pendingIds = () => queue.listPendingOutgoingMessages(runtime).map((message) => message.id);
  return { runtime, queue, request, emitEvent, send, pendingIds };
}

describe('Grok queued ordinary interjections', () => {
  it('sends consecutive corrections in order before the active turn ends', async () => {
    const first = deferred<{ status: string }>();
    const second = deferred<{ status: string }>();
    const request = vi.fn(async (..._args: unknown[]) => ({ status: 'queued' }))
      .mockImplementationOnce(() => first.promise)
      .mockImplementationOnce(() => second.promise);
    const f = fixture(request);
    await f.send('first');
    await vi.waitFor(() => expect(request).toHaveBeenCalledTimes(1));
    await f.send('second');
    await f.send('third');
    expect(f.pendingIds()).toEqual(['first', 'second', 'third']);

    first.resolve({ status: 'queued' });
    await vi.waitFor(() => expect(request).toHaveBeenCalledTimes(2));
    expect(f.pendingIds()).toEqual(['second', 'third']);
    second.resolve({ status: 'queued' });
    await vi.waitFor(() => expect(f.pendingIds()).toEqual([]));

    expect(f.runtime.running).toBe(true);
    expect(request.mock.calls.map(([method, params]) => [method, (params as { text: string }).text]))
      .toEqual(['first', 'second', 'third'].map((text) => ['_x.ai/interject', text]));
    expect(f.emitEvent.mock.calls.map(([, , payload]) => payload.turnCorrelationId))
      .toEqual(['first', 'second', 'third']);
  });

  it('flushes an early correction when the original prompt is acknowledged', async () => {
    const f = fixture();
    f.runtime.submittingMessage = {
      message: { id: 'original', text: 'original', suppressUserEvent: true },
      status: 'submitting', promptRequestIssued: true, kind: 'prompt',
    };
    await f.send('correction');
    expect(f.request).not.toHaveBeenCalled();

    f.queue.confirmPromptAccepted(f.runtime);

    await vi.waitFor(() => expect(f.request).toHaveBeenCalledWith(
      '_x.ai/interject', expect.objectContaining({ text: 'correction' }), expect.anything(),
    ));
    await vi.waitFor(() => expect(f.pendingIds()).toEqual([]));
    expect(f.runtime.running).toBe(true);
    expect(f.emitEvent).toHaveBeenCalledOnce();
  });

  it('preserves internal FIFO turns and starts the following correction when the head is deleted', async () => {
    const f = fixture();
    f.queue.enqueue(f.runtime, 'internal continuation', undefined, {
      deferUserEventUntilTurnStart: true, turnCorrelationId: 'internal',
    });
    await f.send('ordinary correction');
    expect(f.request).not.toHaveBeenCalled();
    expect(f.pendingIds()).toEqual(['internal', 'ordinary correction']);

    await expect(f.queue.removePendingOutgoingMessage(f.runtime, 'internal'))
      .resolves.toMatchObject({ id: 'internal' });

    await vi.waitFor(() => expect(f.request).toHaveBeenCalledWith(
      '_x.ai/interject', expect.objectContaining({ text: 'ordinary correction' }), expect.anything(),
    ));
    expect(f.runtime.running).toBe(true);
  });

  it('does not let a newly sent correction overtake an older queued correction', async () => {
    const f = fixture();
    f.runtime.runtimeMutationInProgress = true;
    await f.send('older');
    f.runtime.runtimeMutationInProgress = false;
    await f.send('newer');

    await vi.waitFor(() => expect(f.pendingIds()).toEqual([]));
    expect(f.request.mock.calls.map(([, params]) => (params as { text: string }).text))
      .toEqual(['older', 'newer']);
  });

  it('releases the next correction when an interjection is deleted and ignores its late receipt', async () => {
    const first = deferred<{ status: string }>();
    const request = vi.fn(async (..._args: unknown[]) => ({ status: 'queued' }))
      .mockImplementationOnce(() => first.promise);
    const f = fixture(request);
    const turnController = new AbortController();
    f.runtime.currentTurnController = turnController;
    await f.send('cancel me');
    await vi.waitFor(() => expect(request).toHaveBeenCalledOnce());
    const firstSignal = (request.mock.calls[0]![2] as { cancellationSignal: AbortSignal }).cancellationSignal;
    await f.send('keep me');

    await expect(f.queue.removePendingOutgoingMessage(f.runtime, 'cancel me'))
      .resolves.toMatchObject({ id: 'cancel me' });

    await vi.waitFor(() => expect(f.pendingIds()).toEqual([]));
    expect(firstSignal.aborted).toBe(true);
    expect(turnController.signal.aborted).toBe(false);
    expect(request).toHaveBeenCalledTimes(2);
    first.resolve({ status: 'queued' });
    await Promise.resolve();
    expect(f.emitEvent.mock.calls.map(([, , payload]) => payload.text)).toEqual(['keep me']);
    expect(f.runtime.running).toBe(true);
  });

  it('does not start queued interjections when the whole turn is being interrupted', async () => {
    const first = deferred<{ status: string }>();
    const f = fixture(vi.fn(async (..._args: unknown[]) => first.promise));
    await f.send('first');
    await vi.waitFor(() => expect(f.request).toHaveBeenCalledOnce());
    await f.send('second');

    f.queue.cancelSubmittingInterjection(f.runtime);
    first.resolve({ status: 'queued' });
    await Promise.resolve();

    expect(f.request).toHaveBeenCalledOnce();
    expect(f.pendingIds()).toEqual(['second']);
    expect(f.emitEvent).not.toHaveBeenCalled();
  });

  it('preserves FIFO order when an unsupported extension falls back behind the active turn', async () => {
    const first = deferred<{ status: string }>();
    const f = fixture(vi.fn(async (..._args: unknown[]) => first.promise));
    await f.send('first');
    await vi.waitFor(() => expect(f.request).toHaveBeenCalledOnce());
    await f.send('second');
    first.reject(Object.assign(new Error('Method not found'), { code: -32601 }));

    await vi.waitFor(() => expect(f.runtime.interjectionSupported).toBe(false));
    expect(f.pendingIds()).toEqual(['first', 'second']);
    expect(f.request).toHaveBeenCalledOnce();
    expect(f.emitEvent).not.toHaveBeenCalled();
  });

  it('continues with later input without replaying an ambiguously failed interjection', async () => {
    const first = deferred<{ status: string }>();
    const request = vi.fn(async (..._args: unknown[]) => ({ status: 'queued' }))
      .mockImplementationOnce(() => first.promise);
    const f = fixture(request);
    await f.send('failed');
    await vi.waitFor(() => expect(request).toHaveBeenCalledOnce());
    await f.send('next');
    first.reject(new Error('transport lost its reply'));

    await vi.waitFor(() => expect(f.pendingIds()).toEqual([]));
    expect(request.mock.calls.map(([, params]) => (params as { text: string }).text)).toEqual(['failed', 'next']);
    expect(f.emitEvent).toHaveBeenCalledWith('app-session', 'message', expect.objectContaining({ error: true }));
    expect(f.emitEvent).toHaveBeenCalledWith('app-session', 'message', expect.objectContaining({ text: 'next', role: 'user' }));
  });

  it.each([false, true])('emits queued ordinary input once with persisted=%s', async (persisted) => {
    const f = fixture();
    f.runtime.submittingMessage = {
      message: { id: 'original', text: 'original', suppressUserEvent: true },
      status: 'submitting', promptRequestIssued: true, kind: 'prompt',
    };
    await f.queue.send(f.runtime, 'ordinary', undefined, { userEventAlreadyPersisted: persisted });
    f.queue.confirmPromptAccepted(f.runtime);

    await vi.waitFor(() => expect(f.request).toHaveBeenCalledOnce());
    await vi.waitFor(() => expect(f.runtime.submittingMessage).toBeNull());
    expect(f.emitEvent).toHaveBeenCalledTimes(persisted ? 0 : 1);
  });

  it('does not re-emit a persisted message on the direct interjection path', async () => {
    const f = fixture();
    await f.queue.send(f.runtime, 'already persisted', undefined, { userEventAlreadyPersisted: true });
    await vi.waitFor(() => expect(f.runtime.submittingMessage).toBeNull());
    expect(f.request).toHaveBeenCalledOnce();
    expect(f.emitEvent).not.toHaveBeenCalled();
  });

  const boundaries = [
    ['cwdTransitionGeneration', 1, null],
    ['runtimeMutationInProgress', true, false],
    ['restartingSandbox', true, false],
    ['suppressUpdates', true, false],
    ['ready', false, true],
    ['interruptRequested', true, false],
  ] as const;

  it.each(boundaries)('holds interjections behind %s until the boundary is released', async (key, blocked, released) => {
    const f = fixture();
    Object.assign(f.runtime, { [key]: blocked });
    await f.send('correction');
    expect(f.request).not.toHaveBeenCalled();
    expect(f.pendingIds()).toEqual(['correction']);

    Object.assign(f.runtime, { [key]: released });
    await f.queue.drain(f.runtime);

    await vi.waitFor(() => expect(f.pendingIds()).toEqual([]));
    expect(f.request).toHaveBeenCalledOnce();
  });

  it.each(boundaries)('rechecks %s after materializing input and retains FIFO position', async (key, blocked, released) => {
    const f = fixture();
    const sending = f.send('first');
    Object.assign(f.runtime, { [key]: blocked });
    await f.send('second');
    await sending;
    await vi.waitFor(() => expect(f.runtime.submittingMessage).toBeNull());
    expect(f.request).not.toHaveBeenCalled();
    expect(f.pendingIds()).toEqual(['first', 'second']);

    Object.assign(f.runtime, { [key]: released });
    await f.queue.drain(f.runtime);

    await vi.waitFor(() => expect(f.pendingIds()).toEqual([]));
    expect(f.request.mock.calls.map(([, params]) => (params as { text: string }).text))
      .toEqual(['first', 'second']);
  });

  it.each(['sealed', 'closed'] as const)('does not send input across the %s boundary', async (key) => {
    const f = fixture();
    const sending = f.send('must not run');
    f.runtime[key] = true;
    await sending;
    await vi.waitFor(() => expect(f.runtime.submittingMessage).toBeNull());
    expect(f.request).not.toHaveBeenCalled();
    expect(f.runtime.queue).toEqual([]);
  });
});
