import type { AgentDeckEventEnvelope } from '@contracts/index';
import { describe, expect, it } from 'vitest';

import {
  createHost,
  createRuntime,
  findMessage,
  hello,
  request,
  sshAccess,
  TestDuplex,
  waitFor,
} from './connection-test-helpers';

describe('daemon framed connection backpressure', () => {
  it('isolates bounded request queues so one abnormal client cannot block another', async () => {
    const runtime = createRuntime({
      execute: async (input) => {
        if (input.requestId === 'slow-1') {
          await new Promise<never>((_resolve, reject) => {
            input.signal.addEventListener('abort', () => reject(new Error('aborted')), {
              once: true,
            });
          });
        }
        return { result: { requestId: input.requestId }, revision: 1 };
      },
    });
    const host = createHost(runtime, { maxConcurrentRequests: 1, maxQueuedRequests: 1 });
    await host.start();
    const slow = new TestDuplex();
    const healthy = new TestDuplex(1024 * 1024);
    const slowConnection = host.accept({ stream: slow, createAccessContext: sshAccess });
    const healthyConnection = host.accept({ stream: healthy, createAccessContext: sshAccess });
    slow.feed(hello('desktop-slow'));
    healthy.feed(hello('desktop-healthy'));
    await waitFor(() => Boolean(findMessage(slow, 'hello-result')), 'slow hello');
    await waitFor(() => Boolean(findMessage(healthy, 'hello-result')), 'healthy hello');

    slow.feed(request('slow-1'));
    slow.feed(request('queued-1'));
    slow.feed(request('overflow-1'));
    await waitFor(() => slowConnection.isClosed, 'queue overflow close');
    expect(healthyConnection.isClosed).toBe(false);
    healthy.feed(request('healthy-1'));
    await waitFor(() => Boolean(findMessage(healthy, 'result', 'healthy-1')), 'healthy result');
    expect(host.connectionCount).toBe(1);
    await host.stop();
  });

  it('isolates an outbound byte-queue overflow to the slow connection', async () => {
    const runtime = createRuntime({
      execute: async (input) => ({
        result: { requestId: input.requestId, payload: 'x'.repeat(1_500) },
        revision: 1,
      }),
    });
    const host = createHost(runtime, { maxQueuedBytes: 4_096 });
    await host.start();
    const slow = new TestDuplex();
    const healthy = new TestDuplex(1024 * 1024);
    const slowConnection = host.accept({ stream: slow, createAccessContext: sshAccess });
    const healthyConnection = host.accept({ stream: healthy, createAccessContext: sshAccess });
    slow.feed(hello('byte-slow'));
    healthy.feed(hello('byte-healthy'));
    await waitFor(() => Boolean(findMessage(slow, 'hello-result')), 'slow hello');
    await waitFor(() => Boolean(findMessage(healthy, 'hello-result')), 'healthy hello');
    await new Promise<void>((resolve) => setImmediate(resolve));
    slow.setWriteBlocked(true);

    slow.feedMany([request('byte-1'), request('byte-2')]);
    await expect(slowConnection.whenClosed()).resolves.toBe(
      'outbound-byte-queue-overflow',
    );
    expect(healthyConnection.isClosed).toBe(false);

    healthy.feed(request('healthy-byte-result'));
    await waitFor(
      () => Boolean(findMessage(healthy, 'result', 'healthy-byte-result')),
      'healthy byte result',
    );
    slow.setWriteBlocked(false);
    await host.stop();
  });

  it('bounds slow event consumers while continuing fanout to healthy connections', async () => {
    const eventListeners = new Map<string, (event: AgentDeckEventEnvelope) => void>();
    let revision = 0;
    const runtime = createRuntime({
      currentRevision: () => revision,
      subscribe: async ({ access, onEvent }) => {
        eventListeners.set(access.clientId, onEvent);
        return {
          close: () => {
            eventListeners.delete(access.clientId);
          },
        };
      },
    });
    const host = createHost(runtime, { maxQueuedEvents: 2, maxQueuedFrames: 4 });
    await host.start();
    const slow = new TestDuplex();
    const healthy = new TestDuplex(1024 * 1024);
    const slowConnection = host.accept({ stream: slow, createAccessContext: sshAccess });
    const healthyConnection = host.accept({ stream: healthy, createAccessContext: sshAccess });
    slow.feed(hello('events-slow'));
    healthy.feed(hello('events-healthy'));
    await waitFor(() => Boolean(findMessage(slow, 'hello-result')), 'slow hello');
    await waitFor(() => Boolean(findMessage(healthy, 'hello-result')), 'healthy hello');
    slow.feed({ type: 'subscribe', requestId: 'sub-slow', afterRevision: 0 });
    healthy.feed({ type: 'subscribe', requestId: 'sub-healthy', afterRevision: 0 });
    await waitFor(() => Boolean(findMessage(slow, 'result', 'sub-slow')), 'slow subscribe');
    await waitFor(() => Boolean(findMessage(healthy, 'result', 'sub-healthy')), 'healthy subscribe');
    await new Promise<void>((resolve) => setImmediate(resolve));
    slow.setWriteBlocked(true);

    for (revision = 1; revision <= 4; revision += 1) {
      for (const listener of [...eventListeners.values()]) {
        listener({
          instanceId: 'tenant-a',
          revision,
          kind: 'session.updated',
          entityId: 'session-1',
          payload: { revision },
        });
      }
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
    await waitFor(() => slowConnection.isClosed, 'slow event close');
    await waitFor(
      () => healthy.decoded().filter((value) => (value as { type?: string }).type === 'event').length === 4,
      'healthy event fanout',
    );
    expect(healthyConnection.isClosed).toBe(false);
    slow.setWriteBlocked(false);
    await host.stop();
  });
});
