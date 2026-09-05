import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { GrokAcpSession } from '../acp-process';
import { createGrokRuntime } from '../runtime-factory';
import { recycleGrokTransport } from '../transport-recovery';
import { GrokTurnQueue } from '../turn-queue';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((next) => { resolve = next; });
  return { promise, resolve };
}

let root: string;
beforeEach(async () => { root = await mkdtemp(join(tmpdir(), 'grok-pending-cancel-')); });
afterEach(async () => { vi.useRealTimers(); await rm(root, { recursive: true, force: true }); });

function fixture() {
  const terminal = deferred<{ stopReason: 'cancelled' }>();
  const stopped = deferred<void>();
  let signal!: AbortSignal;
  const request = vi.fn((_method: string, _params: unknown, options?: { cancellationSignal?: AbortSignal }) => {
    signal = options!.cancellationSignal!;
    // Installed ACP 1.4 only sends $/cancel_request on abort; the RPC can remain unresolved.
    return terminal.promise;
  });
  const notify = vi.fn(async (): Promise<void> => undefined);
  const stop = vi.fn(() => stopped.promise);
  const process = { connection: { agent: { request, notify } }, stop } as unknown as GrokAcpSession;
  const nextRequest = vi.fn(async () => ({ stopReason: 'end_turn' }));
  const nextProcess = { connection: { agent: { request: nextRequest, notify } }, stop: vi.fn() } as unknown as GrokAcpSession;
  const runtime = createGrokRuntime('grok-app', { cwd: root, prompt: '' }, null);
  runtime.nativeSessionId = 'grok-native';
  runtime.process = process;
  runtime.ready = true;
  const emitEvent = vi.fn();
  const emitError = vi.fn();
  const dispose = vi.fn(async () => { runtime.closed = true; });
  const recycle = vi.fn(async () => recycleGrokTransport(runtime, {
    isCurrent: (candidate) => candidate === runtime,
    start: async () => {
      runtime.process = nextProcess;
      runtime.ready = true;
      runtime.suppressUpdates = false;
      void queue.drain(runtime);
      return true;
    },
    persist: vi.fn(), dispose, emitTerminalError: emitError,
  }));
  const queue = new GrokTurnQueue({
    emit: vi.fn(), emitEvent, emitError, closeSession: vi.fn(), recycleRuntime: recycle,
    providerHistoryRoot: root, providerCompletionPollMs: 1_000_000,
  });
  const enqueue = (text = 'remove me', id = 'pending-one') => queue.enqueue(runtime, text, undefined, {
    deferUserEventUntilTurnStart: true, turnCorrelationId: id,
  });
  return { terminal, stopped, request, notify, stop, nextRequest, runtime, emitEvent, emitError,
    recycle, dispose, queue, enqueue, signal: () => signal };
}

describe('Grok pending prompt deletion', () => {
  it('releases the deletion wait even when an earlier interrupt already aborted the RPC signal', async () => {
    const f = fixture();
    f.enqueue();
    await vi.waitFor(() => expect(f.request).toHaveBeenCalledOnce());
    f.runtime.currentTurnController!.abort();
    await expect(f.queue.removePendingOutgoingMessage(f.runtime, 'pending-one')).resolves.toMatchObject({ id: 'pending-one' });
    await vi.waitFor(() => expect(f.stop).toHaveBeenCalledOnce());
    f.stopped.resolve();
    await vi.waitFor(() => expect(f.runtime.ready).toBe(true));
    f.terminal.resolve({ stopReason: 'cancelled' });
  });

  it('unwinds a missing RPC terminal promptly and waits for old transport retirement before queue progress', async () => {
    vi.useFakeTimers();
    const f = fixture();
    f.enqueue();
    await vi.advanceTimersByTimeAsync(0);
    expect(f.request).toHaveBeenCalledOnce();
    f.enqueue('next', 'pending-two');
    const originalController = f.runtime.currentTurnController;
    await expect(f.queue.removePendingOutgoingMessage(f.runtime, 'pending-one')).resolves.toMatchObject({ id: 'pending-one' });
    await vi.advanceTimersByTimeAsync(0);
    expect(f.notify).toHaveBeenCalledWith('session/cancel', { sessionId: 'grok-native' });
    expect(f.signal().aborted).toBe(true);
    expect(f.recycle).toHaveBeenCalledOnce();
    expect(f.stop).toHaveBeenCalledOnce();
    expect(f.runtime.suppressUpdates).toBe(true);
    expect(f.runtime.ready).toBe(false);
    expect(f.nextRequest).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(90_001);
    expect(f.request).toHaveBeenCalledOnce();
    expect(f.nextRequest).not.toHaveBeenCalled();
    f.stopped.resolve();
    await vi.advanceTimersByTimeAsync(0);
    expect(f.nextRequest).toHaveBeenCalled();
    expect(f.runtime.currentTurnController).not.toBe(originalController);
    expect(f.queue.listPendingOutgoingMessages(f.runtime)).toEqual([]);
    const finished = f.emitEvent.mock.calls.filter(([, kind]) => kind === 'finished').length;
    f.terminal.resolve({ stopReason: 'cancelled' });
    await vi.advanceTimersByTimeAsync(0);
    expect(f.emitEvent.mock.calls.filter(([, kind]) => kind === 'finished')).toHaveLength(finished);
    expect(f.emitEvent).not.toHaveBeenCalledWith('grok-app', 'message', expect.objectContaining({ text: 'remove me' }));
    expect(f.emitError).not.toHaveBeenCalled();
  });

  it('lets provider echo win while session/cancel is being written', async () => {
    const f = fixture();
    const notification = deferred<void>();
    f.notify.mockImplementation(() => notification.promise);
    f.enqueue();
    await vi.waitFor(() => expect(f.request).toHaveBeenCalledOnce());
    const removal = f.queue.removePendingOutgoingMessage(f.runtime, 'pending-one');
    f.queue.confirmPromptAccepted(f.runtime);
    notification.resolve();
    await expect(removal).resolves.toBeNull();
    expect(f.signal().aborted).toBe(false);
    expect(f.runtime.ready).toBe(true);
    expect(f.emitEvent).toHaveBeenCalledWith('grok-app', 'message', expect.objectContaining({ text: 'remove me' }));
    f.terminal.resolve({ stopReason: 'cancelled' });
    await vi.waitFor(() => expect(f.runtime.running).toBe(false));
    expect(f.recycle).not.toHaveBeenCalled();
  });

  it('keeps a failed cancel removable and does not abort or fence its active transport', async () => {
    const f = fixture();
    f.enqueue();
    await vi.waitFor(() => expect(f.request).toHaveBeenCalledOnce());
    f.notify.mockRejectedValueOnce(new Error('write failed'));
    await expect(f.queue.removePendingOutgoingMessage(f.runtime, 'pending-one')).rejects.toThrow('write failed');
    expect(f.runtime.submittingMessage?.status).toBe('submitting');
    expect(f.signal().aborted).toBe(false);
    expect(f.runtime.ready).toBe(true);
    f.queue.confirmPromptAccepted(f.runtime);
    f.terminal.resolve({ stopReason: 'cancelled' });
    await vi.waitFor(() => expect(f.runtime.running).toBe(false));
    expect(f.recycle).not.toHaveBeenCalled();
  });

  it('cancels before request issuance without retiring a healthy transport', async () => {
    const f = fixture();
    f.enqueue();
    await expect(f.queue.removePendingOutgoingMessage(f.runtime, 'pending-one')).resolves.toMatchObject({ id: 'pending-one' });
    await vi.waitFor(() => expect(f.runtime.running).toBe(false));
    expect(f.request).not.toHaveBeenCalled();
    expect(f.notify).not.toHaveBeenCalled();
    expect(f.recycle).not.toHaveBeenCalled();
    expect(f.runtime.ready).toBe(true);
  });

  it('keeps later prompts fenced if old transport retirement fails', async () => {
    const f = fixture();
    f.stop.mockRejectedValueOnce(new Error('stop failed'));
    f.enqueue();
    await vi.waitFor(() => expect(f.request).toHaveBeenCalledOnce());
    f.enqueue('next', 'pending-two');
    await f.queue.removePendingOutgoingMessage(f.runtime, 'pending-one');
    await vi.waitFor(() => expect(f.dispose).toHaveBeenCalledOnce());
    expect(f.nextRequest).not.toHaveBeenCalled();
    expect(f.runtime.closed).toBe(true);
    f.terminal.resolve({ stopReason: 'cancelled' });
  });
});
