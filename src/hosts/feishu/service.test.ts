import { describe, expect, it, vi } from 'vitest';

import type { FeishuGatewayRuntimePort } from '@gateways/feishu';

import {
  runFeishuService,
  type FeishuServiceProcessPort,
  type FeishuServiceSignal,
} from './service';

class FakeProcess implements FeishuServiceProcessPort {
  private readonly listeners = new Map<FeishuServiceSignal, Set<() => void>>();

  on(signal: FeishuServiceSignal, listener: () => void): void {
    const current = this.listeners.get(signal) ?? new Set();
    current.add(listener);
    this.listeners.set(signal, current);
  }

  off(signal: FeishuServiceSignal, listener: () => void): void {
    this.listeners.get(signal)?.delete(listener);
  }

  emit(signal: FeishuServiceSignal): void {
    for (const listener of this.listeners.get(signal) ?? []) listener();
  }

  count(): number {
    return [...this.listeners.values()].reduce((sum, listeners) => sum + listeners.size, 0);
  }
}

function runtime(overrides: Partial<FeishuGatewayRuntimePort> = {}): FeishuGatewayRuntimePort {
  return {
    start: vi.fn(async () => undefined),
    close: vi.fn(async () => undefined),
    handle: vi.fn(async () => ({
      acknowledged: true as const,
      duplicate: false,
      code: 'ok',
      toast: 'ok',
    })),
    ...overrides,
  };
}

describe('Feishu headless service lifecycle', () => {
  it('installs signals before startup and closes on a graceful signal', async () => {
    const processPort = new FakeProcess();
    const created = runtime();
    const running = runFeishuService(() => {
      expect(processPort.count()).toBe(2);
      return created;
    }, processPort);
    await Promise.resolve();
    processPort.emit('SIGTERM');
    await expect(running).resolves.toEqual({ reason: 'SIGTERM', exitCode: 0 });
    expect(created.close).toHaveBeenCalledTimes(1);
    expect(processPort.count()).toBe(0);
  });

  it('reports fatal termination and still runs the runtime cleanup barrier', async () => {
    const processPort = new FakeProcess();
    const created = runtime();
    await expect(runFeishuService((onFatal) => {
      onFatal();
      return created;
    }, processPort)).resolves.toEqual({ reason: 'fatal', exitCode: 1 });
    expect(created.close).toHaveBeenCalledTimes(1);
  });

  it('attempts cleanup after startup failure and removes signal handlers', async () => {
    const processPort = new FakeProcess();
    const created = runtime({ start: vi.fn(async () => { throw new Error('raw startup'); }) });
    await expect(runFeishuService(() => created, processPort)).rejects.toThrow('raw startup');
    expect(created.close).toHaveBeenCalledTimes(1);
    expect(processPort.count()).toBe(0);
  });
});
