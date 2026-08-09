import { describe, expect, it, vi } from 'vitest';
import { type FeishuGatewayClock } from '@gateways/im';
import { createFeishuAuditBundle } from './audit';
import { validateFeishuConnectionHealth } from './health';
import { FeishuLongConnection } from './long-connection';
import type {
  FeishuConnectionHealth,
  FeishuHealthStore,
  FeishuSdkConnectionCallbacks,
} from './types';

const INSTANCE_ID = 'instance-1';
const BASE: FeishuConnectionHealth = {
  instanceId: INSTANCE_ID,
  state: 'connected',
  generation: 4,
  reconnectAttempts: 2,
  lastErrorCode: null,
  updatedAt: 100,
};

const clock: FeishuGatewayClock = {
  now: () => 101,
  setTimer: () => ({ cancel: () => undefined }),
};

const audit = createFeishuAuditBundle({
  appId: 'cli_0123456789abcdef',
  tenantKey: 'tenant_1',
  instanceId: INSTANCE_ID,
  topology: 'relay',
}, clock, () => undefined);

function connectionWith(
  getHealth: () => FeishuConnectionHealth | null,
  onFatal = vi.fn(),
): { callbacks: () => FeishuSdkConnectionCallbacks; connection: FeishuLongConnection; puts: FeishuConnectionHealth[] } {
  let callbacks: FeishuSdkConnectionCallbacks | null = null;
  const puts: FeishuConnectionHealth[] = [];
  const health: FeishuHealthStore = {
    getHealth,
    putHealth: (value) => puts.push({ ...value }),
  };
  const connection = new FeishuLongConnection({
    instanceId: INSTANCE_ID,
    factory: (value) => {
      callbacks = value;
      return { start: () => undefined, close: () => undefined };
    },
    handlers: { onMessage: vi.fn(), onCardAction: vi.fn() },
    health,
    clock,
    audit,
    startupTimeoutMs: 100,
    reconnectTimeoutMs: 100,
    onFatal,
  });
  return {
    callbacks: () => callbacks as unknown as FeishuSdkConnectionCallbacks,
    connection,
    puts,
  };
}

describe('persisted Feishu connection health validation', () => {
  it('accepts and freezes only the exact pinned metadata shape', () => {
    const result = validateFeishuConnectionHealth({ ...BASE }, INSTANCE_ID);
    expect(result).toEqual(BASE);
    expect(Object.isFrozen(result)).toBe(true);
    expect(validateFeishuConnectionHealth(null, INSTANCE_ID)).toBeNull();
  });

  it.each([
    ['array', []],
    ['extra field', { ...BASE, text: 'not metadata' }],
    ['foreign instance', { ...BASE, instanceId: 'instance-2' }],
    ['unknown state', { ...BASE, state: 'ready' }],
    ['negative generation', { ...BASE, generation: -1 }],
    ['fractional generation', { ...BASE, generation: 1.5 }],
    ['unsafe generation', { ...BASE, generation: Number.MAX_SAFE_INTEGER + 1 }],
    ['negative reconnects', { ...BASE, reconnectAttempts: -1 }],
    ['unsafe timestamp', { ...BASE, updatedAt: Number.MAX_SAFE_INTEGER + 1 }],
    ['error outside failed state', { ...BASE, lastErrorCode: 'sdk-start-error' }],
    ['missing failed error', { ...BASE, state: 'failed', lastErrorCode: null }],
    ['unknown failed error', { ...BASE, state: 'failed', lastErrorCode: 'secret-value' }],
    ['missing field', {
      instanceId: INSTANCE_ID,
      state: 'connected',
      generation: 4,
      reconnectAttempts: 2,
      lastErrorCode: null,
    }],
  ])('rejects tampered metadata: %s', (_label, value) => {
    expect(() => validateFeishuConnectionHealth(value, INSTANCE_ID)).toThrow(
      expect.objectContaining({ code: 'invalid_configuration' }),
    );
  });

  it('fails construction before the SDK factory sees corrupt or exhausted persisted state', () => {
    expect(() => connectionWith(() => ({ ...BASE, generation: -1 }))).toThrow(
      expect.objectContaining({ code: 'invalid_configuration' }),
    );
    expect(() => connectionWith(() => ({
      ...BASE,
      generation: Number.MAX_SAFE_INTEGER,
    }))).toThrow(expect.objectContaining({ code: 'invalid_configuration' }));
    expect(() => connectionWith(() => ({
      ...BASE,
      reconnectAttempts: Number.MAX_SAFE_INTEGER,
    }))).toThrow(expect.objectContaining({ code: 'invalid_configuration' }));
  });

  it('replaces untrusted store read failures with one fixed redacted error', () => {
    let failure: unknown;
    try {
      connectionWith(() => { throw new Error('persisted-secret-value'); });
    } catch (error) {
      failure = error;
    }
    expect(failure).toMatchObject({ code: 'invalid_configuration' });
    expect((failure as Error).message).toBe('Persisted Feishu connection health could not be read');
    expect(String(failure)).not.toContain('persisted-secret-value');
  });

  it('fails before overflowing a restored generation and persists only the safe terminal value', async () => {
    const fatal = vi.fn();
    const fixture = connectionWith(() => ({
      ...BASE,
      generation: Number.MAX_SAFE_INTEGER - 1,
      reconnectAttempts: 0,
    }), fatal);
    const started = fixture.connection.start();
    fixture.callbacks().onReady();
    await started;
    fixture.callbacks().onReconnecting();
    fixture.callbacks().onReconnected();
    expect(fixture.puts.at(-1)).toEqual(expect.objectContaining({
      state: 'failed',
      generation: Number.MAX_SAFE_INTEGER,
      reconnectAttempts: 1,
      lastErrorCode: 'health-counter-overflow',
    }));
    expect(fatal).toHaveBeenCalledWith('health-counter-overflow');
  });
});
