import { describe, expect, it, vi } from 'vitest';

import { CdpBridge } from '../cdp';

import { FakeDebugger } from './_fakes';

function makeBridge(): { bridge: CdpBridge; target: FakeDebugger } {
  const target = new FakeDebugger();
  return { bridge: new CdpBridge(() => target as unknown as Electron.Debugger), target };
}

function deferred<T>(): {
  promise: Promise<T>;
  reject: (error: unknown) => void;
  resolve: (value: T) => void;
} {
  let reject!: (error: unknown) => void;
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((promiseResolve, promiseReject) => {
    resolve = promiseResolve;
    reject = promiseReject;
  });
  return { promise, reject, resolve };
}

function sentMethods(target: FakeDebugger): string[] {
  return target.sendCommand.mock.calls.map(([method]) => method);
}

describe('CdpBridge event forwarding', () => {
  it('normalizes the empty top-level session id to undefined', async () => {
    const { bridge, target } = makeBridge();
    const listener = vi.fn();
    bridge.attach();
    bridge.onMessage(listener);

    target.emit('message', {}, 'Page.loadEventFired', { timestamp: 1 }, '');
    target.emit('message', {}, 'Runtime.executionContextCreated', {}, 'child-session');

    // An empty string must not be forwarded: the official Browser client would treat page traffic as
    // child-target traffic, drop Fetch.requestPaused, and deadlock navigation (REVIEW_177).
    expect(listener).toHaveBeenNthCalledWith(1, 'Page.loadEventFired', { timestamp: 1 }, undefined);
    expect(listener).toHaveBeenNthCalledWith(2, 'Runtime.executionContextCreated', {}, 'child-session');
  });

  it('attaches once and tolerates an already-attached debugger', () => {
    const { bridge, target } = makeBridge();
    bridge.attach();
    bridge.attach();

    expect(target.attach).toHaveBeenCalledOnce();
    expect(target.attach).toHaveBeenCalledWith('1.3');
  });

  it('reports detach to subscribers', () => {
    const { bridge, target } = makeBridge();
    const onDetach = vi.fn();
    bridge.attach();
    bridge.onDetach(onDetach);

    target.detach();

    expect(onDetach).toHaveBeenCalledWith('target closed');
  });

  it('passes the child session id through on send', async () => {
    const { bridge, target } = makeBridge();
    await bridge.send('Runtime.evaluate', { expression: '1' }, 'child-session');

    expect(target.sendCommand).toHaveBeenLastCalledWith(
      'Runtime.evaluate',
      { expression: '1' },
      'child-session',
    );
  });
});

describe('CdpBridge log capture', () => {
  it('enables console domains once and records console output', async () => {
    const { bridge, target } = makeBridge();
    await bridge.enableConsoleCapture();
    await bridge.enableConsoleCapture();

    const enabled = target.sent.map((entry) => entry.method);
    expect(enabled.filter((method) => method === 'Runtime.enable')).toHaveLength(1);
    expect(enabled).toContain('Log.enable');

    target.emit('message', {}, 'Runtime.consoleAPICalled', {
      type: 'warning',
      args: [{ value: 'hydration mismatch' }, { value: 42 }],
    });
    target.emit('message', {}, 'Runtime.exceptionThrown', {
      exceptionDetails: { text: 'Uncaught TypeError', exception: { description: 'x is not a function' } },
    });

    const entries = bridge.readConsole(10);
    expect(entries).toHaveLength(2);
    expect(entries[0]).toMatchObject({ level: 'warning', text: 'hydration mismatch 42' });
    expect(entries[1]).toMatchObject({ level: 'error', text: 'Uncaught TypeError' });
  });

  it('shares one console enable promise across concurrent callers', async () => {
    const { bridge, target } = makeBridge();
    const runtime = deferred<void>();
    const log = deferred<void>();
    target.sendCommand.mockImplementation(async (method, params, sessionId) => {
      if (method === 'Runtime.enable') await runtime.promise;
      if (method === 'Log.enable') await log.promise;
      return { method, params, sessionId };
    });

    const first = bridge.enableConsoleCapture();
    const second = bridge.enableConsoleCapture();

    expect(second).toBe(first);
    expect(sentMethods(target).filter((method) => method === 'Runtime.enable')).toHaveLength(1);
    expect(sentMethods(target)).not.toContain('Log.enable');

    runtime.resolve();
    await vi.waitFor(() => {
      expect(sentMethods(target).filter((method) => method === 'Log.enable')).toHaveLength(1);
    });
    log.resolve();
    await Promise.all([first, second]);
    await bridge.enableConsoleCapture();

    expect(sentMethods(target).filter((method) => method === 'Runtime.enable')).toHaveLength(1);
    expect(sentMethods(target).filter((method) => method === 'Log.enable')).toHaveLength(1);
  });

  it('stays disabled and retries both domains after Runtime.enable fails', async () => {
    const { bridge, target } = makeBridge();
    let rejectRuntime = true;
    target.sendCommand.mockImplementation(async (method, params, sessionId) => {
      if (method === 'Runtime.enable' && rejectRuntime) {
        rejectRuntime = false;
        throw new Error('runtime enable failed');
      }
      return { method, params, sessionId };
    });

    await expect(bridge.enableConsoleCapture()).rejects.toThrow('runtime enable failed');
    expect(sentMethods(target)).toEqual(['Runtime.enable']);

    await bridge.enableConsoleCapture();
    await bridge.enableConsoleCapture();
    expect(sentMethods(target)).toEqual([
      'Runtime.enable',
      'Runtime.enable',
      'Log.enable',
    ]);
  });

  it('retries Runtime and Log after Log.enable fails following Runtime success', async () => {
    const { bridge, target } = makeBridge();
    let rejectLog = true;
    target.sendCommand.mockImplementation(async (method, params, sessionId) => {
      if (method === 'Log.enable' && rejectLog) {
        rejectLog = false;
        throw new Error('log enable failed');
      }
      return { method, params, sessionId };
    });

    await expect(bridge.enableConsoleCapture()).rejects.toThrow('log enable failed');
    expect(sentMethods(target)).toEqual(['Runtime.enable', 'Log.enable']);

    await bridge.enableConsoleCapture();
    await bridge.enableConsoleCapture();
    expect(sentMethods(target)).toEqual([
      'Runtime.enable',
      'Log.enable',
      'Runtime.enable',
      'Log.enable',
    ]);
  });

  it('invalidates a stale enable attempt on detach without clobbering the retry', async () => {
    const { bridge, target } = makeBridge();
    const staleRuntime = deferred<void>();
    let runtimeCalls = 0;
    target.sendCommand.mockImplementation(async (method, params, sessionId) => {
      if (method === 'Runtime.enable') {
        runtimeCalls += 1;
        if (runtimeCalls === 1) await staleRuntime.promise;
      }
      return { method, params, sessionId };
    });

    const stale = bridge.enableConsoleCapture();
    target.detach();
    const current = bridge.enableConsoleCapture();
    await current;
    expect(sentMethods(target)).toEqual(['Runtime.enable', 'Runtime.enable', 'Log.enable']);

    staleRuntime.resolve();
    await stale;
    await bridge.enableConsoleCapture();

    expect(sentMethods(target)).toEqual(['Runtime.enable', 'Runtime.enable', 'Log.enable']);
  });

  it('pairs network requests with their response or failure', async () => {
    const { bridge, target } = makeBridge();
    await bridge.enableNetworkCapture();

    target.emit('message', {}, 'Network.requestWillBeSent', {
      requestId: 'r1',
      request: { method: 'GET', url: 'http://127.0.0.1:3456/api/list' },
    });
    target.emit('message', {}, 'Network.responseReceived', {
      requestId: 'r1',
      response: { status: 200, mimeType: 'application/json' },
    });
    expect(bridge.networkActivityState().inFlight).toBe(1);
    target.emit('message', {}, 'Network.loadingFinished', { requestId: 'r1' });
    target.emit('message', {}, 'Network.requestWillBeSent', {
      requestId: 'r2',
      request: { method: 'POST', url: 'http://127.0.0.1:3456/api/save' },
    });
    target.emit('message', {}, 'Network.loadingFailed', {
      requestId: 'r2',
      errorText: 'net::ERR_CONNECTION_REFUSED',
    });

    expect(bridge.readNetwork(10)).toMatchObject([
      { method: 'GET', url: 'http://127.0.0.1:3456/api/list', status: 200, mimeType: 'application/json' },
      { method: 'POST', url: 'http://127.0.0.1:3456/api/save', failure: 'net::ERR_CONNECTION_REFUSED' },
    ]);
    expect(bridge.networkActivityState().inFlight).toBe(0);
  });

  it('records a failure that arrives after response headers', async () => {
    const { bridge, target } = makeBridge();
    await bridge.enableNetworkCapture();

    target.emit('message', {}, 'Network.requestWillBeSent', {
      requestId: 'stream-reset',
      request: { method: 'GET', url: 'http://127.0.0.1/stream' },
    });
    target.emit('message', {}, 'Network.responseReceived', {
      requestId: 'stream-reset',
      response: { status: 200, mimeType: 'application/json' },
    });
    expect(bridge.readNetwork(10)).toEqual([]);
    target.emit('message', {}, 'Network.loadingFailed', {
      requestId: 'stream-reset',
      errorText: 'net::ERR_CONNECTION_RESET',
    });

    expect(bridge.readNetwork(10)).toEqual([
      expect.objectContaining({
        url: 'http://127.0.0.1/stream',
        status: 200,
        failure: 'net::ERR_CONNECTION_RESET',
      }),
    ]);
  });

  it('tracks lifecycle before capture without recording requests retroactively', async () => {
    const { bridge, target } = makeBridge();
    await bridge.enableNetworkTracking();

    target.emit('message', {}, 'Network.requestWillBeSent', {
      requestId: 'early',
      request: { method: 'GET', url: 'http://127.0.0.1/early' },
    });
    expect(bridge.networkActivityState().inFlight).toBe(1);

    await bridge.enableNetworkCapture();
    target.emit('message', {}, 'Network.responseReceived', {
      requestId: 'early',
      response: { status: 200 },
    });
    target.emit('message', {}, 'Network.loadingFinished', { requestId: 'early' });

    expect(bridge.readNetwork(10)).toEqual([]);
    expect(target.sent.filter((entry) => entry.method === 'Network.enable')).toHaveLength(1);
  });

  it('re-enables capture after a detach', async () => {
    const { bridge, target } = makeBridge();
    await bridge.enableNetworkCapture();
    target.detach();
    await bridge.enableNetworkCapture();

    expect(target.sent.filter((entry) => entry.method === 'Network.enable')).toHaveLength(2);
  });

  it('returns only the newest entries up to the requested limit', async () => {
    const { bridge, target } = makeBridge();
    await bridge.enableConsoleCapture();
    for (let index = 0; index < 5; index += 1) {
      target.emit('message', {}, 'Log.entryAdded', {
        entry: { level: 'info', text: `line ${index}` },
      });
    }

    expect(bridge.readConsole(2).map((entry) => entry.text)).toEqual(['line 3', 'line 4']);
  });
});
