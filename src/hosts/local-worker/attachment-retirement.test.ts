import { afterEach, describe, expect, it, vi } from 'vitest';

import type { WorkerAttachRequest, WorkerAttached } from '@protocol/relay';
import type { RelayRouteFrame } from '@protocol/relay';
import {
  WorkerAttachmentController,
  type WorkerAttachmentConnector,
  type WorkerAttachmentSession,
  type WorkerAttachmentSessionHandlers,
} from './attachment';
import type { LocalWorkerSshConfig } from './config';

const SSH_CONFIG: LocalWorkerSshConfig = {
  sshBinary: '/usr/bin/ssh',
  host: 'relay.example.com',
  port: 22,
  user: 'agent-deck-relay',
  identityFile: '/worker/id_ed25519',
  knownHostsFile: '/worker/known_hosts',
  instanceId: 'instance-a',
  workerId: 'worker-a',
  credentialId: 'credential-a',
  connectTimeoutSeconds: 10,
};

class FakeSession implements WorkerAttachmentSession {
  handlers: WorkerAttachmentSessionHandlers | null = null;
  closeCalls = 0;
  closeResult: Promise<void> = Promise.resolve();
  closeError: Error | null = null;
  setHandlersError: Error | null = null;

  constructor(readonly attached: WorkerAttached) {}

  setHandlers(handlers: WorkerAttachmentSessionHandlers): void {
    this.handlers = handlers;
    if (this.setHandlersError) throw this.setHandlersError;
  }

  send(_frame: RelayRouteFrame): void {}

  close(): Promise<void> {
    this.closeCalls += 1;
    return this.closeError ? Promise.reject(this.closeError) : this.closeResult;
  }

  disconnect(): void {
    this.handlers?.onClose(new Error('lost'));
  }
}

class FakeConnector implements WorkerAttachmentConnector {
  readonly requests: WorkerAttachRequest[] = [];
  readonly outcomes: FakeSession[] = [];

  async connect(_config: LocalWorkerSshConfig, request: WorkerAttachRequest): Promise<FakeSession> {
    this.requests.push(request);
    const session = this.outcomes.shift();
    if (!session) throw new Error('No fake connection outcome');
    return session;
  }
}

function attached(
  generation: number,
  limits: Partial<
    Pick<WorkerAttached, 'initialCreditBytes' | 'maxCreditBytes' | 'maxFrameBytes'>
  > = {},
): WorkerAttached {
  return {
    type: 'attached',
    instanceId: 'instance-a',
    workerId: 'worker-a',
    generation,
    heartbeatTimeoutMs: 30,
    initialCreditBytes: 256 * 1024,
    maxCreditBytes: 1024 * 1024,
    maxFrameBytes: 4 * 1024 * 1024,
    ...limits,
  };
}

function deferred(): { promise: Promise<void>; resolve(): void } {
  let resolve!: () => void;
  const promise = new Promise<void>((next) => {
    resolve = next;
  });
  return { promise, resolve };
}

const CHANNELS = {
  open: () => ({ write: () => true, closeInput: vi.fn(), reset: vi.fn() }),
};

afterEach(() => {
  vi.useRealTimers();
});

describe('Worker attachment negotiated limits and retirement serialization', () => {
  it('accepts matching custom negotiated bridge limits', async () => {
    const connector = new FakeConnector();
    connector.outcomes.push(
      new FakeSession(attached(1, { initialCreditBytes: 2, maxCreditBytes: 4, maxFrameBytes: 1024 })),
    );
    const controller = new WorkerAttachmentController(SSH_CONFIG, connector, CHANNELS, {
      bridgeLimits: {
        initialCreditBytes: 2,
        maxCreditBytes: 4,
        maxOutputQueueBytesPerStream: 8,
        maxOutputQueueBytesTotal: 16,
        maxOutputQueueFramesPerStream: 8,
        maxOutputQueueFramesTotal: 16,
        maxFrameBytes: 1024,
      },
    });

    await controller.start();
    expect(controller.status()).toEqual(expect.objectContaining({ state: 'online', generation: 1 }));
    await controller.stop();
  });

  it('fences malformed negotiated route limits', async () => {
    const connector = new FakeConnector();
    const session = new FakeSession(attached(1, { initialCreditBytes: 5, maxCreditBytes: 4 }));
    connector.outcomes.push(session);
    const controller = new WorkerAttachmentController(SSH_CONFIG, connector, CHANNELS);

    await controller.start();
    expect(session.closeCalls).toBe(1);
    expect(controller.status()).toEqual(
      expect.objectContaining({ state: 'fenced', lastErrorCode: 'route_limits_invalid' }),
    );
  });

  it('waits for old child retirement before takeover connects', async () => {
    const connector = new FakeConnector();
    const gate = deferred();
    const first = new FakeSession(attached(1));
    first.closeResult = gate.promise;
    connector.outcomes.push(first, new FakeSession(attached(2)));
    const controller = new WorkerAttachmentController(SSH_CONFIG, connector, CHANNELS);
    await controller.start();

    const takeover = controller.requestTakeover(1);
    await vi.waitFor(() => expect(first.closeCalls).toBe(1));
    expect(connector.requests).toHaveLength(1);
    gate.resolve();
    await takeover;
    expect(connector.requests).toHaveLength(2);
    expect(controller.status()).toEqual(expect.objectContaining({ state: 'online', generation: 2 }));
    await controller.stop();
  });

  it('waits for retirement before scheduling reconnect backoff', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const connector = new FakeConnector();
    const gate = deferred();
    const first = new FakeSession(attached(1));
    first.closeResult = gate.promise;
    connector.outcomes.push(first, new FakeSession(attached(1)));
    const controller = new WorkerAttachmentController(SSH_CONFIG, connector, CHANNELS, {
      backoffInitialMs: 5,
      backoffMaximumMs: 5,
      backoffJitterRatio: 0,
    });
    await controller.start();
    first.disconnect();
    await vi.advanceTimersByTimeAsync(50);
    expect(first.closeCalls).toBe(1);
    expect(connector.requests).toHaveLength(1);

    gate.resolve();
    await vi.advanceTimersByTimeAsync(0);
    expect(controller.status()).toEqual(expect.objectContaining({ state: 'backoff' }));
    await vi.advanceTimersByTimeAsync(5);
    expect(connector.requests).toHaveLength(2);
    await controller.stop();
  });

  it('surfaces cleanup failure and permanently fences reconnect', async () => {
    const connector = new FakeConnector();
    const session = new FakeSession(attached(1));
    session.setHandlersError = new Error('setup failed');
    session.closeError = new Error('child survived SIGKILL');
    connector.outcomes.push(session, new FakeSession(attached(1)));
    const controller = new WorkerAttachmentController(SSH_CONFIG, connector, CHANNELS);

    await expect(controller.start()).rejects.toThrow('retirement failed');
    expect(controller.status()).toEqual(
      expect.objectContaining({ state: 'fenced', lastErrorCode: 'retirement_failed' }),
    );
    await expect(controller.requestTakeover(1)).rejects.toThrow('retirement failed');
    expect(connector.requests).toHaveLength(1);
  });

  it('still retires the child when scheduler cancellation throws', async () => {
    const connector = new FakeConnector();
    const session = new FakeSession(attached(1));
    connector.outcomes.push(session);
    const controller = new WorkerAttachmentController(SSH_CONFIG, connector, CHANNELS, {
      scheduler: {
        set: () => Symbol('heartbeat'),
        clear: () => {
          throw new Error('scheduler clear failed');
        },
      },
    });

    await controller.start();
    await controller.stop();

    expect(session.closeCalls).toBe(1);
    expect(controller.status().state).toBe('stopped');
  });
});
