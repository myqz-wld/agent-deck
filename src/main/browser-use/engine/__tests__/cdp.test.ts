import { describe, expect, it, vi } from 'vitest';

import { CdpBridge } from '../cdp';

import { FakeDebugger } from './_fakes';

function makeBridge(): { bridge: CdpBridge; target: FakeDebugger } {
  const target = new FakeDebugger();
  return { bridge: new CdpBridge(() => target as unknown as Electron.Debugger), target };
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
