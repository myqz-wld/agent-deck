import { AgentDeckCapability, type CoreMethodMap } from '@contracts/index';
import type { AgentDeckClient } from '@contracts/client';
import type { ElectronHostRegistry, ElectronHostState } from '@hosts/electron';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const browser = vi.hoisted(() => ({ dispose: vi.fn(async () => {}) }));
vi.mock('@main/browser-use/session-browser', () => ({
  disposeSessionBrowser: browser.dispose,
}));

import { RemoteHostDesktopBrowserBroker } from './desktop-browser-broker';

function until(assertion: () => void): Promise<void> {
  return new Promise((resolve, reject) => {
    let attempts = 0;
    const check = (): void => {
      try { assertion(); resolve(); } catch (error) {
        if (++attempts > 100) { reject(error); return; }
        setTimeout(check, 5);
      }
    };
    check();
  });
}

describe('RemoteHostDesktopBrowserBroker', () => {
  beforeEach(() => browser.dispose.mockClear());

  it('polls independently of source selection, responds, and retires owners on disconnect', async () => {
    let state: ElectronHostState = {
      profileId: 'profile-a',
      clientId: 'desktop-a',
      topology: 'full',
      status: 'connected',
      instanceId: 'instance-a',
      authoritativeCoreId: 'core-a',
      workerGeneration: null,
      capabilities: [AgentDeckCapability.Browser],
      eventRevision: 0,
      error: null,
    };
    let delivered = false;
    const calls: string[] = [];
    const request = vi.fn(async (method: keyof CoreMethodMap, _params: unknown, options?: {
      signal?: AbortSignal;
    }) => {
      calls.push(method);
      if (method === 'desktop.broker.next' && !delivered) {
        delivered = true;
        return {
          request: {
            requestId: 'request-a', sessionId: 'session-a', kind: 'browser',
            operation: 'browser_tabs', args: {}, leaseMs: 1_000,
          },
          revision: 1,
        };
      }
      if (method === 'desktop.broker.respond') return { accepted: true, revision: 1 };
      return await new Promise((_resolve, reject) => {
        options?.signal?.addEventListener('abort', () => reject(new Error('cancelled')), {
          once: true,
        });
      });
    });
    const client = { request } as unknown as AgentDeckClient<CoreMethodMap>;
    const registry = {
      getClient: () => client,
      state: () => state,
    } as unknown as ElectronHostRegistry;
    const execute = vi.fn(async () => ({
      content: [{ type: 'text' as const, text: '{"tabs":[]}' }],
    }));
    const broker = new RemoteHostDesktopBrowserBroker({ registry, execute });
    broker.handleState(state);
    await until(() => expect(calls).toContain('desktop.broker.respond'));
    expect(execute).toHaveBeenCalledWith(
      expect.stringMatching(/^remote-browser-[a-f0-9]{64}$/),
      expect.objectContaining({ sessionId: 'session-a' }),
    );

    state = { ...state, status: 'offline' };
    broker.handleState(state);
    await until(() => expect(browser.dispose).toHaveBeenCalledOnce());
    await broker.stop();
  });

  it('disposes only the session named by a terminal Core event', async () => {
    const state: ElectronHostState = {
      profileId: 'profile-a', clientId: 'desktop-a', topology: 'full',
      status: 'connected', instanceId: 'instance-a', authoritativeCoreId: 'core-a',
      workerGeneration: 1, capabilities: [AgentDeckCapability.Browser],
      eventRevision: 0, error: null,
    };
    let delivered = false;
    const client = {
      request: vi.fn(async (method: keyof CoreMethodMap, _params: unknown, options?: {
        signal?: AbortSignal;
      }) => {
        if (method === 'desktop.broker.next' && !delivered) {
          delivered = true;
          return {
            request: {
              requestId: 'request-a', sessionId: 'session-a', kind: 'browser',
              operation: 'browser_tabs', args: {}, leaseMs: 1_000,
            }, revision: 1,
          };
        }
        if (method === 'desktop.broker.respond') return { accepted: true, revision: 1 };
        return await new Promise((_resolve, reject) => options?.signal?.addEventListener(
          'abort', () => reject(new Error('cancelled')), { once: true },
        ));
      }),
    } as unknown as AgentDeckClient<CoreMethodMap>;
    const registry = { getClient: () => client, state: () => state } as unknown as ElectronHostRegistry;
    const broker = new RemoteHostDesktopBrowserBroker({
      registry,
      execute: async () => ({ content: [{ type: 'text', text: '{}' }] }),
    });
    broker.handleState(state);
    await until(() => expect(delivered).toBe(true));
    broker.handleEvent({
      profileId: 'profile-a', instanceId: 'instance-a', revision: 2,
      kind: 'session.updated', entityId: 'session-a', payload: { lifecycle: 'closed' },
    });
    await until(() => expect(browser.dispose).toHaveBeenCalledOnce());
    await broker.stop();
  });

  it('expires a slow browser operation on the relative lease and drops its late result', async () => {
    const state: ElectronHostState = {
      profileId: 'profile-a', clientId: 'desktop-a', topology: 'full',
      status: 'connected', instanceId: 'instance-a', authoritativeCoreId: 'core-a',
      workerGeneration: 1, capabilities: [AgentDeckCapability.Browser],
      eventRevision: 0, error: null,
    };
    let delivered = false;
    const request = vi.fn(async (method: keyof CoreMethodMap, _params: unknown, options?: {
      signal?: AbortSignal;
    }) => {
      if (method === 'desktop.broker.next' && !delivered) {
        delivered = true;
        return {
          request: {
            requestId: 'request-slow', sessionId: 'session-a', kind: 'browser',
            operation: 'browser_tabs', args: {}, leaseMs: 1,
          }, revision: 1,
        };
      }
      if (method === 'desktop.broker.respond') return { accepted: true, revision: 1 };
      return await new Promise((_resolve, reject) => options?.signal?.addEventListener(
        'abort', () => reject(new Error('cancelled')), { once: true },
      ));
    });
    let finishExecute!: (value: { content: [{ type: 'text'; text: string }] }) => void;
    const execute = vi.fn(() => new Promise<{ content: [{ type: 'text'; text: string }] }>(
      (resolve) => { finishExecute = resolve; },
    ));
    const client = { request } as unknown as AgentDeckClient<CoreMethodMap>;
    const registry = { getClient: () => client, state: () => state } as unknown as ElectronHostRegistry;
    const broker = new RemoteHostDesktopBrowserBroker({ registry, execute });
    broker.handleState(state);

    await until(() => expect(request.mock.calls.filter(([method]) =>
      method === 'desktop.broker.respond')).toHaveLength(1));
    expect(browser.dispose).toHaveBeenCalledOnce();
    expect(JSON.stringify(request.mock.calls.find(([method]) =>
      method === 'desktop.broker.respond')?.[1])).toContain('expired before desktop execution');

    finishExecute({ content: [{ type: 'text', text: '{"late":true}' }] });
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(request.mock.calls.filter(([method]) => method === 'desktop.broker.respond'))
      .toHaveLength(1);
    await broker.stop();
  });
});
