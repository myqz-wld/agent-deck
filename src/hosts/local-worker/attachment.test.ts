import { afterEach, describe, expect, it, vi } from 'vitest';
import { issueRemoteOwnerGrantClaim } from '@contracts/index';

import type { WorkerAttachRequest, WorkerAttached } from '@protocol/relay';
import { emptyRoutePayload, type RelayRouteFrame } from '@protocol/relay';
import {
  WorkerAttachmentConnectError,
  WorkerAttachmentController,
  type WorkerAttachmentConnector,
  type WorkerAttachmentSession,
  type WorkerAttachmentSessionHandlers,
} from './attachment';
import type { LocalWorkerSshConfig } from './config';
import { MAX_ATTACHMENT_TIMER_MS } from './attachment-validation';

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
  readonly sent: RelayRouteFrame[] = [];
  handlers: WorkerAttachmentSessionHandlers | null = null;
  closed = false;
  closeCalls = 0;
  closeResult: Promise<void> = Promise.resolve();
  closeError: Error | null = null;
  setHandlersError: Error | null = null;
  frameDuringSetHandlers: RelayRouteFrame | null = null;

  constructor(readonly attached: WorkerAttached) {}

  setHandlers(handlers: WorkerAttachmentSessionHandlers): void {
    this.handlers = handlers;
    if (this.frameDuringSetHandlers) handlers.onFrame(this.frameDuringSetHandlers);
    if (this.setHandlersError) throw this.setHandlersError;
  }

  send(frame: RelayRouteFrame): void {
    if (this.closed) throw new Error('closed');
    this.sent.push(frame);
  }

  close(): Promise<void> {
    this.closed = true;
    this.closeCalls += 1;
    if (this.closeError) return Promise.reject(this.closeError);
    return this.closeResult;
  }

  receive(frame: RelayRouteFrame): void {
    this.handlers?.onFrame(frame);
  }

  disconnect(error = new Error('lost')): void {
    this.handlers?.onClose(error);
  }
}

class FakeConnector implements WorkerAttachmentConnector {
  readonly requests: WorkerAttachRequest[] = [];
  readonly outcomes: Array<FakeSession | Error> = [];

  async connect(_config: LocalWorkerSshConfig, request: WorkerAttachRequest): Promise<FakeSession> {
    this.requests.push(request);
    const outcome = this.outcomes.shift();
    if (!outcome) throw new Error('No fake connection outcome');
    if (outcome instanceof Error) throw outcome;
    return outcome;
  }
}

function attached(
  generation: number,
  heartbeatTimeoutMs = 30,
  limits: Partial<
    Pick<WorkerAttached, 'initialCreditBytes' | 'maxCreditBytes' | 'maxFrameBytes'>
  > = {},
): WorkerAttached {
  return {
    type: 'attached',
    instanceId: 'instance-a',
    workerId: 'worker-a',
    generation,
    heartbeatTimeoutMs,
    initialCreditBytes: 256 * 1024,
    maxCreditBytes: 1024 * 1024,
    maxFrameBytes: 4 * 1024 * 1024,
    ...limits,
  };
}

function heartbeat(generation: number, sequence: number): RelayRouteFrame {
  return {
    instanceId: 'instance-a',
    generation,
    streamId: '$lease',
    direction: 'client-to-worker',
    sequence,
    kind: 'heartbeat',
    payload: emptyRoutePayload(),
    creditBytes: null,
    resetCode: null,
    connectionScope: null,
    accessSurface: null,
    accessGrant: null,
  };
}

afterEach(() => {
  vi.useRealTimers();
});

describe('background local Worker attachment state machine', () => {
  it('validates generation and every timer against the real setTimeout range', () => {
    const connector = new FakeConnector();
    const channels = { open: () => ({ write: () => true, closeInput: vi.fn(), reset: vi.fn() }) };
    expect(
      () => new WorkerAttachmentController(SSH_CONFIG, connector, channels, { initialGeneration: 0 }),
    ).toThrow('initialGeneration');
    expect(
      () =>
        new WorkerAttachmentController(SSH_CONFIG, connector, channels, {
          heartbeatIntervalMs: MAX_ATTACHMENT_TIMER_MS + 1,
        }),
    ).toThrow('heartbeatIntervalMs');
    expect(
      () =>
        new WorkerAttachmentController(SSH_CONFIG, connector, channels, {
          backoffInitialMs: 20,
          backoffMaximumMs: 10,
        }),
    ).toThrow('backoffInitialMs cannot exceed');
  });

  it('registers, heartbeats, reconnects the same generation, and applies bounded backoff', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const connector = new FakeConnector();
    const first = new FakeSession(attached(1));
    const second = new FakeSession(attached(1));
    connector.outcomes.push(first, second);
    const generations: number[] = [];
    const controller = new WorkerAttachmentController(
      SSH_CONFIG,
      connector,
      { open: () => ({ write: () => true, closeInput: vi.fn(), reset: vi.fn() }) },
      {
        heartbeatIntervalMs: 10,
        backoffInitialMs: 5,
        backoffMaximumMs: 20,
        backoffJitterRatio: 0,
        onGeneration: (generation) => { generations.push(generation); },
      },
    );

    await controller.start();
    expect(connector.requests[0]).toEqual(
      expect.objectContaining({ mode: 'register', generation: null }),
    );
    expect(controller.status()).toEqual(
      expect.objectContaining({ state: 'online', generation: 1, attempt: 0 }),
    );
    await vi.advanceTimersByTimeAsync(10);
    expect(first.sent).toEqual([
      expect.objectContaining({ kind: 'heartbeat', sequence: 0, direction: 'worker-to-client' }),
    ]);
    first.receive(heartbeat(1, 0));
    expect(controller.status().lastHeartbeatAckAt).toBe(10);

    first.disconnect();
    await vi.advanceTimersByTimeAsync(0);
    expect(controller.status()).toEqual(
      expect.objectContaining({ state: 'backoff', attempt: 1, nextRetryAt: 15 }),
    );
    await vi.advanceTimersByTimeAsync(5);
    expect(connector.requests[1]).toEqual(
      expect.objectContaining({ mode: 'reconnect', generation: 1 }),
    );
    expect(controller.status()).toEqual(
      expect.objectContaining({ state: 'online', generation: 1, attempt: 0 }),
    );
    expect(generations).toEqual([1, 1]);
    await controller.stop();
  });

  it('persists the negotiated generation before exposing route handlers or online state', async () => {
    const connector = new FakeConnector();
    const session = new FakeSession(attached(1));
    connector.outcomes.push(session);
    let release!: () => void;
    const persisted = new Promise<void>((resolve) => { release = resolve; });
    const controller = new WorkerAttachmentController(
      SSH_CONFIG,
      connector,
      { open: () => ({ write: () => true, closeInput: vi.fn(), reset: vi.fn() }) },
      { onGeneration: () => persisted },
    );

    const starting = controller.start();
    await vi.waitFor(() => expect(connector.requests).toHaveLength(1));
    expect(session.handlers).toBeNull();
    expect(controller.status().state).toBe('connecting');
    release();
    await starting;
    expect(session.handlers).not.toBeNull();
    expect(controller.status().state).toBe('online');
    await controller.stop();
  });

  it('fails closed into fenced state on generation conflict until explicit takeover', async () => {
    const connector = new FakeConnector();
    connector.outcomes.push(
      new WorkerAttachmentConnectError({
        type: 'rejected',
        code: 'worker_already_registered',
        message: 'already registered',
        retryable: false,
        currentGeneration: 1,
      }),
      new FakeSession(attached(2)),
    );
    const controller = new WorkerAttachmentController(
      SSH_CONFIG,
      connector,
      { open: () => ({ write: () => true, closeInput: vi.fn(), reset: vi.fn() }) },
      { backoffJitterRatio: 0 },
    );

    await controller.start();
    expect(controller.status()).toEqual(
      expect.objectContaining({ state: 'fenced', lastErrorCode: 'worker_already_registered' }),
    );
    expect(connector.requests).toHaveLength(1);

    await controller.requestTakeover(1);
    expect(connector.requests[1]).toEqual(
      expect.objectContaining({
        mode: 'takeover',
        generation: null,
        expectedGeneration: 1,
      }),
    );
    expect(controller.status()).toEqual(expect.objectContaining({ state: 'online', generation: 2 }));
    await controller.stop();
  });

  it('fences and closes a reconnect response with a mismatched generation', async () => {
    const connector = new FakeConnector();
    const session = new FakeSession(attached(2));
    connector.outcomes.push(session);
    const controller = new WorkerAttachmentController(
      SSH_CONFIG,
      connector,
      { open: () => ({ write: () => true, closeInput: vi.fn(), reset: vi.fn() }) },
      { initialGeneration: 1 },
    );

    await controller.start();
    expect(connector.requests[0]).toEqual(expect.objectContaining({ mode: 'reconnect', generation: 1 }));
    expect(session.closed).toBe(true);
    expect(controller.status()).toEqual(
      expect.objectContaining({ state: 'fenced', lastErrorCode: 'attached_generation_mismatch' }),
    );
  });

  it('rejects an advertised heartbeat timeout outside the timer boundary', async () => {
    const connector = new FakeConnector();
    const session = new FakeSession(attached(1, MAX_ATTACHMENT_TIMER_MS + 1));
    connector.outcomes.push(session);
    const controller = new WorkerAttachmentController(
      SSH_CONFIG,
      connector,
      { open: () => ({ write: () => true, closeInput: vi.fn(), reset: vi.fn() }) },
    );

    await controller.start();
    expect(session.closed).toBe(true);
    expect(controller.status()).toEqual(
      expect.objectContaining({ state: 'fenced', lastErrorCode: 'heartbeat_timeout_invalid' }),
    );
  });

  it('cleans a resolved session and bridge when setHandlers fails', async () => {
    const connector = new FakeConnector();
    const session = new FakeSession(attached(1));
    session.frameDuringSetHandlers = {
      instanceId: 'instance-a',
      generation: 1,
      streamId: 'cleanup-stream',
      direction: 'client-to-worker',
      sequence: 0,
      kind: 'open',
      payload: emptyRoutePayload(),
      creditBytes: null,
      resetCode: null,
      connectionScope: 'client-credential-a',
      accessSurface: 'desktop',
      accessGrant: issueRemoteOwnerGrantClaim('desktop'),
    };
    session.setHandlersError = new Error('handler setup failed');
    const reset = vi.fn();
    connector.outcomes.push(session);
    const controller = new WorkerAttachmentController(
      SSH_CONFIG,
      connector,
      { open: () => ({ write: () => true, closeInput: vi.fn(), reset }) },
      { backoffInitialMs: 10, backoffMaximumMs: 10, backoffJitterRatio: 0 },
    );

    await controller.start();
    expect(session.closed).toBe(true);
    expect(session.closeCalls).toBe(1);
    expect(reset).toHaveBeenCalledWith('worker_disconnected');
    expect(controller.status()).toEqual(
      expect.objectContaining({ state: 'backoff', attempt: 1, lastErrorCode: 'Error' }),
    );
    await controller.stop();
  });

  it('closes a resolved session when bridge setup rejects its limits', async () => {
    const connector = new FakeConnector();
    const session = new FakeSession(attached(1));
    connector.outcomes.push(session);
    const controller = new WorkerAttachmentController(
      SSH_CONFIG,
      connector,
      { open: () => ({ write: () => true, closeInput: vi.fn(), reset: vi.fn() }) },
      {
        backoffInitialMs: 10,
        backoffMaximumMs: 10,
        backoffJitterRatio: 0,
        bridgeLimits: {
          initialCreditBytes: 1,
          maxCreditBytes: 1,
          maxOutputQueueBytesPerStream: 1,
          maxOutputQueueBytesTotal: 1,
          maxOutputQueueFramesPerStream: 2,
          maxOutputQueueFramesTotal: 1,
          maxFrameBytes: 1,
        },
      },
    );

    await controller.start();
    expect(session.closed).toBe(true);
    expect(session.handlers).toBeNull();
    expect(controller.status()).toEqual(
      expect.objectContaining({
        state: 'fenced',
        generation: 1,
        lastErrorCode: 'route_limits_mismatch',
      }),
    );
    await controller.stop();
  });

  it.each(['status', 'generation'] as const)(
    'cleans up and backs off when the %s observer throws after connect',
    async (observer) => {
      const connector = new FakeConnector();
      const session = new FakeSession(attached(1));
      connector.outcomes.push(session);
      const controller = new WorkerAttachmentController(
        SSH_CONFIG,
        connector,
        { open: () => ({ write: () => true, closeInput: vi.fn(), reset: vi.fn() }) },
        {
          backoffInitialMs: 10,
          backoffMaximumMs: 10,
          backoffJitterRatio: 0,
          onStatus:
            observer === 'status'
              ? (status) => {
                  if (status.state === 'online') throw new Error('status observer failed');
                }
              : undefined,
          onGeneration:
            observer === 'generation'
              ? () => {
                  throw new Error('generation observer failed');
                }
              : undefined,
        },
      );

      await expect(controller.start()).resolves.toBeUndefined();
      expect(controller.status()).toEqual(
        expect.objectContaining({ state: 'backoff', generation: 1, attempt: 1 }),
      );
      expect(session.closed).toBe(true);
      await controller.stop();
    },
  );

  it('closes a silent connection after the negotiated heartbeat timeout', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const connector = new FakeConnector();
    const session = new FakeSession(attached(1, 15));
    connector.outcomes.push(session);
    const controller = new WorkerAttachmentController(
      SSH_CONFIG,
      connector,
      { open: () => ({ write: () => true, closeInput: vi.fn(), reset: vi.fn() }) },
      {
        heartbeatIntervalMs: 5,
        backoffInitialMs: 10,
        backoffMaximumMs: 10,
        backoffJitterRatio: 0,
      },
    );

    await controller.start();
    await vi.advanceTimersByTimeAsync(20);
    expect(session.closed).toBe(true);
    expect(controller.status()).toEqual(
      expect.objectContaining({ state: 'backoff', attempt: 1, nextRetryAt: 30 }),
    );
    await controller.stop();
  });

  it('never opens a listener or substitutes server compute while the connector is unavailable', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(100);
    const connector = new FakeConnector();
    connector.outcomes.push(new Error('relay offline'));
    const channelFactory = { open: vi.fn() };
    const controller = new WorkerAttachmentController(
      SSH_CONFIG,
      connector,
      channelFactory,
      {
        backoffInitialMs: 10,
        backoffMaximumMs: 10,
        backoffJitterRatio: 0,
      },
    );

    await controller.start();
    expect(controller.status()).toEqual(
      expect.objectContaining({ state: 'backoff', nextRetryAt: 110 }),
    );
    expect(channelFactory.open).not.toHaveBeenCalled();
    expect(connector.requests).toHaveLength(1);
    await controller.stop();
  });
});
