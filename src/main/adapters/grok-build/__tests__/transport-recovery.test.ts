import { describe, expect, it, vi } from 'vitest';

import type { GrokAcpProcess } from '../acp-process';
import { recycleGrokTransport } from '../transport-recovery';
import type { GrokRuntime } from '../runtime-types';
import { createGrokTranslationState } from '../translate';

function makeRuntime(process: GrokAcpProcess): GrokRuntime {
  return {
    applicationSessionId: 'app-session',
    nativeSessionId: 'native-session',
    cwd: '/repo',
    process,
    ready: false,
    queue: [{ id: 'queued-1', text: 'keep queued' }],
    submittingMessage: null,
    running: false,
    currentTurnController: null,
    interruptRequested: false,
    interjectionSupported: null,
    sealed: false,
    closed: false,
    disposed: false,
    suppressUpdates: true,
    model: null,
    runtimeIdentity: null,
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

describe('Grok transport recovery', () => {
  it('replaces the failed child while preserving the native session and FIFO', async () => {
    const stop = vi.fn(async () => undefined);
    const oldProcess = {
      stop,
      child: { pid: 10 },
    } as unknown as GrokAcpProcess;
    const newProcess = {
      child: { pid: 11 },
    } as unknown as GrokAcpProcess;
    const runtime = makeRuntime(oldProcess);
    const persist = vi.fn();
    const start = vi.fn(async (candidate: GrokRuntime) => {
      candidate.process = newProcess;
      candidate.ready = true;
      candidate.suppressUpdates = false;
      return true;
    });

    await recycleGrokTransport(runtime, {
      isCurrent: (candidate) => candidate === runtime,
      start,
      persist,
      dispose: vi.fn(async () => undefined),
      emitErrorMessage: vi.fn(),
    });

    expect(stop).toHaveBeenCalledOnce();
    expect(start).toHaveBeenCalledWith(runtime);
    expect(persist).toHaveBeenCalledWith(runtime);
    expect(runtime.process).toBe(newProcess);
    expect(runtime.nativeSessionId).toBe('native-session');
    expect(runtime.queue.map((message) => message.text)).toEqual(['keep queued']);
  });

  it('releases an unstartable runtime and leaves a visible recovery error', async () => {
    const oldProcess = {
      stop: vi.fn(async () => undefined),
      child: { pid: 10 },
    } as unknown as GrokAcpProcess;
    const runtime = makeRuntime(oldProcess);
    const emitErrorMessage = vi.fn();
    const dispose = vi.fn(async (candidate: GrokRuntime) => {
      candidate.closed = true;
    });

    await recycleGrokTransport(runtime, {
      isCurrent: (candidate) => candidate === runtime,
      start: vi.fn(async () => {
        throw new Error('load failed');
      }),
      persist: vi.fn(),
      dispose,
      emitErrorMessage,
    });

    expect(emitErrorMessage).toHaveBeenCalledWith(
      'app-session',
      expect.stringContaining('ACP 连接重建失败：load failed'),
    );
    expect(dispose).toHaveBeenCalledWith(runtime);
    expect(runtime.closed).toBe(true);
  });
});
