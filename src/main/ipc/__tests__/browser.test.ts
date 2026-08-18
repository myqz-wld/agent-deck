import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  handle: vi.fn(),
  controller: {
    get: vi.fn(), begin: vi.fn(), update: vi.fn(), select: vi.fn(), close: vi.fn(),
    park: vi.fn(), observeProjection: vi.fn(),
  },
  subscribe: vi.fn(),
  safeSend: vi.fn(),
}));

vi.mock('electron', () => ({ ipcMain: { handle: mocks.handle } }));
vi.mock('@main/utils/logger', () => ({
  default: { scope: () => ({ warn: vi.fn() }) },
}));
vi.mock('@main/browser-use/browser-presentation-runtime', () => ({
  getBrowserPresentationController: () => mocks.controller,
}));
vi.mock('@main/browser-use/browser-state-projection', () => ({
  getBrowserStateProjectionRegistry: () => ({ subscribe: mocks.subscribe }),
}));
vi.mock('@main/index/_deps', () => ({ makeSafeSend: () => mocks.safeSend }));
vi.mock('@main/window', () => ({ getFloatingWindow: () => ({ window: null }) }));

import { IpcEvent, IpcInvoke } from '@shared/ipc-channels';
import { registerBrowserIpc } from '../browser';

function handler(channel: string) {
  return mocks.handle.mock.calls.find(([candidate]) => candidate === channel)?.[1];
}

describe('Browser presentation IPC registration', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    registerBrowserIpc();
  });

  it('derives renderer identity only from the invoke event', () => {
    const begin = handler(IpcInvoke.BrowserPresentationBegin);
    begin({ sender: { id: 73 } }, {
      source: { kind: 'local', sessionId: 'session-a' }, expectedRevision: 2,
    });
    expect(mocks.controller.begin).toHaveBeenCalledWith(
      73,
      { kind: 'local', sessionId: 'session-a' },
      2,
    );

    const update = handler(IpcInvoke.BrowserPresentationUpdate);
    update({ sender: { id: 73 } }, {
      leaseId: 'lease-a', tabId: 4,
      bounds: { x: 10, y: 100, width: 480, height: 600 },
    });
    expect(mocks.controller.update).toHaveBeenCalledWith(
      73, 'lease-a', 4, { x: 10, y: 100, width: 480, height: 600 },
    );
  });

  it('reconciles native presentation before projecting metadata to renderer', () => {
    const listener = mocks.subscribe.mock.calls[0]?.[0];
    const event = {
      source: { kind: 'local', sessionId: 'session-a' },
      revision: 3,
      snapshot: null,
    };
    listener(event);

    expect(mocks.controller.observeProjection).toHaveBeenCalledWith(event);
    expect(mocks.safeSend).toHaveBeenCalledWith(IpcEvent.BrowserStateChanged, event);
    expect(mocks.controller.observeProjection.mock.invocationCallOrder[0])
      .toBeLessThan(mocks.safeSend.mock.invocationCallOrder[0]);
  });
});
