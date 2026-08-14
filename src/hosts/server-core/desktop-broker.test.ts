import {
  issueRemoteOwnerGrantClaim,
  type AuthenticatedClientAccessContext,
} from '@contracts/index';
import { describe, expect, it } from 'vitest';

import { ServerCoreDesktopBroker } from './desktop-broker';

function access(
  clientId: string,
  credentialId = `credential-${clientId}`,
): AuthenticatedClientAccessContext {
  return {
    kind: 'authenticated-client',
    topology: 'full',
    instanceId: 'instance-a',
    clientId,
    transport: 'ssh',
    connectionScope: credentialId,
    authority: 'owner-equivalent',
    surface: 'desktop',
    grant: issueRemoteOwnerGrantClaim('desktop'),
  };
}

describe('ServerCoreDesktopBroker', () => {
  it('binds a session to the first polling desktop and rejects cross-client responses', async () => {
    let sequence = 0;
    const broker = new ServerCoreDesktopBroker({
      createId: () => `request-${++sequence}`,
      requestTimeoutMs: 1_000,
    });
    await broker.start();
    try {
      const firstResult = broker.invoke('session-a', 'browser_tabs', {});
      const first = await broker.next(access('desktop-a'), { waitMs: 100 }, new AbortController().signal);
      expect(first.request).toMatchObject({
        requestId: 'request-1',
        sessionId: 'session-a',
        operation: 'browser_tabs',
      });
      expect(() => broker.respond(access('desktop-b'), {
        requestId: 'request-1',
        result: { content: [{ type: 'text', text: '{"tabs":[]}' }] },
      })).toThrow('another desktop');
      expect(broker.respond(access('desktop-a'), {
        requestId: 'request-1',
        result: { content: [{ type: 'text', text: '{"tabs":[]}' }] },
      })).toEqual({ accepted: true });
      await expect(firstResult).resolves.toEqual({
        content: [{ type: 'text', text: '{"tabs":[]}' }],
      });

      const secondResult = broker.invoke('session-a', 'browser_open', { url: 'about:blank' });
      await expect(broker.next(
        access('desktop-b'),
        { waitMs: 100 },
        new AbortController().signal,
      )).resolves.toEqual({ request: null });
      const second = await broker.next(
        access('desktop-a'),
        { waitMs: 100 },
        new AbortController().signal,
      );
      expect(second.request?.requestId).toBe('request-2');
      broker.respond(access('desktop-a'), {
        requestId: 'request-2',
        result: { content: [{ type: 'text', text: '{"tabId":1}' }] },
      });
      await expect(secondResult).resolves.toMatchObject({ content: [{ type: 'text' }] });
    } finally {
      await broker.stop();
    }
  });

  it('cancels long polls, releases closed sessions, and stops all pending calls', async () => {
    const broker = new ServerCoreDesktopBroker({ requestTimeoutMs: 1_000 });
    await broker.start();
    const controller = new AbortController();
    const poll = broker.next(access('desktop-a'), { waitMs: 500 }, controller.signal);
    controller.abort();
    await expect(poll).rejects.toThrow('cancelled');

    const closed = broker.invoke('session-a', 'browser_tabs', {});
    broker.releaseSession('session-a', 'Session closed');
    await expect(closed).rejects.toThrow('Session closed');

    const pending = broker.invoke('session-b', 'browser_tabs', {});
    await broker.stop();
    await expect(pending).rejects.toThrow('stopped');
    await expect(broker.invoke('session-c', 'browser_tabs', {})).rejects.toThrow();
  });

  it('enforces global and per-session pending bounds', async () => {
    const broker = new ServerCoreDesktopBroker({
      maxPending: 2,
      maxPendingPerSession: 1,
      requestTimeoutMs: 1_000,
    });
    await broker.start();
    const first = broker.invoke('session-a', 'browser_tabs', {});
    await expect(broker.invoke('session-a', 'browser_open', {})).rejects.toThrow('Session browser');
    const second = broker.invoke('session-b', 'browser_tabs', {});
    await expect(broker.invoke('session-c', 'browser_tabs', {})).rejects.toThrow('Desktop browser');
    await broker.stop();
    await Promise.allSettled([first, second]);
  });

  it('re-elects a replacement desktop only after the bound client lease expires', async () => {
    let now = 1_000;
    let sequence = 0;
    const broker = new ServerCoreDesktopBroker({
      bindingLeaseMs: 1_000,
      createId: () => `request-${++sequence}`,
      now: () => now,
      requestTimeoutMs: 1_000,
    });
    await broker.start();
    try {
      const firstResult = broker.invoke('session-a', 'browser_tabs', {});
      await broker.next(access('desktop-a'), { waitMs: 100 }, new AbortController().signal);
      broker.respond(access('desktop-a'), {
        requestId: 'request-1',
        result: { content: [{ type: 'text', text: 'first' }] },
      });
      await firstResult;

      const secondResult = broker.invoke('session-a', 'browser_tabs', {});
      now += 1_001;
      const replacement = await broker.next(
        access('desktop-b'), { waitMs: 100 }, new AbortController().signal,
      );
      expect(replacement.request?.requestId).toBe('request-2');
      broker.respond(access('desktop-b'), {
        requestId: 'request-2',
        result: { content: [{ type: 'text', text: 'replacement' }] },
      });
      await expect(secondResult).resolves.toMatchObject({
        content: [{ text: 'replacement' }],
      });
    } finally {
      await broker.stop();
    }
  });
});
