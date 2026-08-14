import { describe, expect, it, vi } from 'vitest';
import {
  FeishuSessionConsoleGateway,
  type FeishuGatewayClock,
} from '@gateways/im';
import { createFeishuAuditBundle } from './audit';
import { FeishuSdkEventAdapter } from './event-adapter';
import { FeishuLongConnection } from './long-connection';
import {
  FeishuProductionRuntime,
  FeishuProductionRuntimeShutdownError,
} from './runtime';
import { SqliteFeishuGatewayStore } from './sqlite-store';
import type {
  FeishuConnectionHealth,
  FeishuSdkConnectionCallbacks,
} from './types';

class ManualClock implements FeishuGatewayClock {
  private sequence = 0;
  private time = 100;
  private readonly timers = new Map<number, { at: number; callback: () => void }>();

  now(): number {
    return this.time;
  }

  setTimer(callback: () => void, delayMs: number): { cancel(): void } {
    const id = ++this.sequence;
    this.timers.set(id, { at: this.time + delayMs, callback });
    return { cancel: () => this.timers.delete(id) };
  }

  advance(milliseconds: number): void {
    this.time += milliseconds;
    for (const [id, timer] of [...this.timers]) {
      if (timer.at <= this.time) {
        this.timers.delete(id);
        timer.callback();
      }
    }
  }
}

function deferred() {
  let resolve!: () => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<void>((accept, decline) => {
    resolve = accept;
    reject = decline;
  });
  return { promise, reject, resolve };
}

function runtimeFixture(input: {
  clock?: ManualClock;
  connection?: FeishuLongConnection;
  connectionClose?: () => void;
  connectionStart?: () => Promise<void>;
  gatewayClose?: () => Promise<void>;
  gatewayStart?: () => Promise<void>;
  secretDispose?: () => void;
  storeClose?: () => void;
} = {}) {
  const clock = input.clock ?? new ManualClock();
  const gateway = {
    start: vi.fn(input.gatewayStart ?? (async () => undefined)),
    close: vi.fn(input.gatewayClose ?? (async () => undefined)),
  } as unknown as FeishuSessionConsoleGateway;
  const events = { handle: vi.fn() } as unknown as FeishuSdkEventAdapter;
  const fakeConnection = {
    start: vi.fn(input.connectionStart ?? (async () => undefined)),
    close: vi.fn(input.connectionClose ?? (() => undefined)),
  } as unknown as FeishuLongConnection;
  const connection = input.connection ?? fakeConnection;
  const store = {
    close: vi.fn(input.storeClose ?? (() => undefined)),
  } as unknown as SqliteFeishuGatewayStore;
  const actionSecret = {
    dispose: vi.fn(input.secretDispose ?? (() => undefined)),
  };
  const fatal = vi.fn();
  const runtime = new FeishuProductionRuntime(
    gateway,
    events,
    connection,
    store,
    actionSecret,
    clock,
    100,
    50,
    async () => ({ state: 'connected' }),
    fatal,
  );
  return { actionSecret, connection, events, fakeConnection, fatal, gateway, runtime, store };
}

function failingRealConnection(clock: FeishuGatewayClock) {
  let callbacks: FeishuSdkConnectionCallbacks | null = null;
  let durable: FeishuConnectionHealth | null = null;
  const stoppedWrites: FeishuConnectionHealth[] = [];
  const auditEntries: unknown[] = [];
  const sdk = {
    start: vi.fn(),
    close: vi.fn(() => { throw new Error('sdk-close-sensitive-value'); }),
  };
  const connection = new FeishuLongConnection({
    instanceId: 'instance-1',
    factory: (value) => {
      callbacks = value;
      return sdk;
    },
    handlers: { onMessage: vi.fn(), onCardAction: vi.fn() },
    health: {
      getHealth: () => null,
      putHealth: (value) => {
        if (value.state === 'stopped') {
          stoppedWrites.push({ ...value });
          throw new Error('health-close-sensitive-value');
        }
        durable = { ...value };
      },
    },
    clock,
    audit: createFeishuAuditBundle({
      appId: 'cli_0123456789abcdef',
      tenantKey: 'tenant_1',
      instanceId: 'instance-1',
      topology: 'relay',
    }, clock, (entry) => auditEntries.push(entry)),
    startupTimeoutMs: 100,
    reconnectTimeoutMs: 100,
    onFatal: vi.fn(),
  });
  return {
    auditEntries,
    callbacks: () => callbacks as unknown as FeishuSdkConnectionCallbacks,
    connection,
    durable: () => durable as FeishuConnectionHealth | null,
    sdk,
    stoppedWrites,
  };
}

describe('Feishu production runtime startup terminal state', () => {
  it('shares exactly one in-flight start across concurrent callers', async () => {
    const gate = deferred();
    const fixture = runtimeFixture({ gatewayStart: () => gate.promise });
    const first = fixture.runtime.start();
    const concurrent = fixture.runtime.start();
    expect(concurrent).toBe(first);
    expect(fixture.gateway.start).toHaveBeenCalledTimes(1);
    expect(fixture.fakeConnection.start).not.toHaveBeenCalled();
    gate.resolve();
    await expect(first).resolves.toBeUndefined();
    expect(fixture.fakeConnection.start).toHaveBeenCalledTimes(1);
    await fixture.runtime.close();
  });

  it('never reuses a resolved start after a successful close', async () => {
    const fixture = runtimeFixture();
    await expect(fixture.runtime.start()).resolves.toBeUndefined();
    await expect(fixture.runtime.start()).resolves.toBeUndefined();
    await fixture.runtime.close();
    await expect(fixture.runtime.start()).rejects.toMatchObject({
      code: 'gateway_closed',
      message: 'Feishu production runtime is closed',
    });
    expect(fixture.gateway.start).toHaveBeenCalledTimes(1);
    expect(fixture.fakeConnection.start).toHaveBeenCalledTimes(1);
  });

  it('closes deterministically during startup and cannot restart afterward', async () => {
    const gate = deferred();
    const fixture = runtimeFixture({ gatewayStart: () => gate.promise });
    const started = fixture.runtime.start();
    await fixture.runtime.close();
    gate.resolve();
    await expect(started).rejects.toMatchObject({
      code: 'lifecycle_failed',
      message: 'Feishu production runtime failed to start',
    });
    expect(fixture.fakeConnection.start).not.toHaveBeenCalled();
    await expect(fixture.runtime.start()).rejects.toMatchObject({ code: 'gateway_closed' });
  });

  it('keeps a rejected startup terminal and redacts the dependency failure', async () => {
    const fixture = runtimeFixture({
      gatewayStart: async () => { throw new Error('startup-secret-value'); },
    });
    const failure = await fixture.runtime.start().catch((error: unknown) => error);
    expect(failure).toMatchObject({
      code: 'lifecycle_failed',
      message: 'Feishu production runtime failed to start',
    });
    expect(String(failure)).not.toContain('startup-secret-value');
    await expect(fixture.runtime.start()).rejects.toMatchObject({ code: 'gateway_closed' });
  });
});

describe('Feishu production runtime shutdown cleanup', () => {
  it('aggregates real SDK/health close failures and still completes every later cleanup', async () => {
    const clock = new ManualClock();
    const real = failingRealConnection(clock);
    const fixture = runtimeFixture({ clock, connection: real.connection });
    const started = fixture.runtime.start();
    await vi.waitFor(() => expect(real.sdk.start).toHaveBeenCalledTimes(1));
    real.callbacks().onReady();
    await started;

    const failure = await fixture.runtime.close().catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(FeishuProductionRuntimeShutdownError);
    expect((failure as FeishuProductionRuntimeShutdownError).failureCodes).toEqual([
      'connection-close-failed',
    ]);
    expect(real.sdk.close).toHaveBeenCalledWith(true);
    expect(real.stoppedWrites).toHaveLength(1);
    expect(real.durable()).toMatchObject({ state: 'connected' });
    expect(fixture.gateway.close).toHaveBeenCalledTimes(1);
    expect(fixture.actionSecret.dispose).toHaveBeenCalledTimes(1);
    expect(fixture.store.close).toHaveBeenCalledTimes(1);
    expect(JSON.stringify([failure, real.auditEntries])).not.toMatch(
      /sdk-close-sensitive-value|health-close-sensitive-value/u,
    );
  });

  it('attempts every safe cleanup, redacts failures, and becomes terminal after rejection', async () => {
    const order: string[] = [];
    const fixture = runtimeFixture({
      connectionClose: () => {
        order.push('connection');
        throw new Error('connection-secret');
      },
      gatewayClose: async () => {
        order.push('gateway');
        throw new Error('gateway-secret');
      },
      secretDispose: () => {
        order.push('secret');
        throw new Error('action-secret');
      },
      storeClose: () => {
        order.push('store');
        throw new Error('store-secret');
      },
    });

    const first = fixture.runtime.close();
    const concurrent = fixture.runtime.close();
    expect(concurrent).toBe(first);
    const failure = await first.catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(FeishuProductionRuntimeShutdownError);
    expect((failure as FeishuProductionRuntimeShutdownError).failureCodes).toEqual([
      'connection-close-failed',
      'gateway-close-failed',
      'action-secret-disposal-failed',
      'metadata-store-close-failed',
    ]);
    expect(order).toEqual(['connection', 'gateway', 'secret', 'store']);
    expect(JSON.stringify((failure as AggregateError).errors)).not.toContain('secret');
    await expect(fixture.runtime.close()).resolves.toBeUndefined();
    await expect(fixture.runtime.handle({})).rejects.toMatchObject({ code: 'gateway_closed' });
    expect(order).toEqual(['connection', 'gateway', 'secret', 'store']);
  });

  it('shares one close race and disposes the MAC only after the gateway barrier', async () => {
    const order: string[] = [];
    const barrier = deferred();
    const fixture = runtimeFixture({
      connectionClose: () => { order.push('connection'); },
      gatewayClose: () => {
        order.push('gateway');
        return barrier.promise;
      },
      secretDispose: () => { order.push('secret'); },
      storeClose: () => { order.push('store'); },
    });
    const first = fixture.runtime.close();
    const concurrent = fixture.runtime.close();
    expect(concurrent).toBe(first);
    await Promise.resolve();
    expect(order).toEqual(['connection', 'gateway']);
    expect(fixture.actionSecret.dispose).not.toHaveBeenCalled();
    expect(fixture.store.close).not.toHaveBeenCalled();

    barrier.resolve();
    await expect(first).resolves.toBeUndefined();
    await expect(concurrent).resolves.toBeUndefined();
    expect(order).toEqual(['connection', 'gateway', 'secret', 'store']);
    await expect(fixture.runtime.close()).resolves.toBeUndefined();
    expect(fixture.connection.close).toHaveBeenCalledTimes(1);
  });

  it('becomes terminal on timeout and defers secret/store cleanup until the barrier settles', async () => {
    const clock = new ManualClock();
    const barrier = deferred();
    const order: string[] = [];
    const fixture = runtimeFixture({
      clock,
      connectionClose: () => { order.push('connection'); },
      gatewayClose: () => {
        order.push('gateway');
        return barrier.promise;
      },
      secretDispose: () => { order.push('secret'); },
      storeClose: () => {
        order.push('store');
        throw new Error('deferred-store-secret');
      },
    });
    const closing = fixture.runtime.close();
    clock.advance(50);
    const failure = await closing.catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(FeishuProductionRuntimeShutdownError);
    expect((failure as FeishuProductionRuntimeShutdownError).failureCodes).toEqual([
      'gateway-close-timeout',
    ]);
    expect(order).toEqual(['connection', 'gateway']);
    expect(fixture.actionSecret.dispose).not.toHaveBeenCalled();
    expect(fixture.store.close).not.toHaveBeenCalled();
    await expect(fixture.runtime.close()).resolves.toBeUndefined();

    barrier.resolve();
    await vi.waitFor(() => {
      expect(order).toEqual(['connection', 'gateway', 'secret', 'store']);
    });
    expect(fixture.fatal).toHaveBeenCalledWith('deferred-cleanup-failed');
  });
});
