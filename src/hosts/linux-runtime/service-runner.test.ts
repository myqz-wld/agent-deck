import { describe, expect, it, vi } from 'vitest';

import { AgentDeckCompositionController } from '@composition/controller';
import type { AgentDeckComposition, LifecycleComponent } from '@composition/runtime';

import {
  runCompositionService,
  type ServiceProcessPort,
  type ServiceSignal,
} from './service-runner';

class FakeProcess implements ServiceProcessPort {
  readonly listeners = new Map<ServiceSignal, Set<() => void>>();
  readonly diagnostics: string[] = [];
  readonly exits: number[] = [];

  on(signal: ServiceSignal, listener: () => void): void {
    const listeners = this.listeners.get(signal) ?? new Set();
    listeners.add(listener);
    this.listeners.set(signal, listeners);
  }

  off(signal: ServiceSignal, listener: () => void): void {
    this.listeners.get(signal)?.delete(listener);
  }

  emit(signal: ServiceSignal): void {
    for (const listener of this.listeners.get(signal) ?? []) listener();
  }

  writeDiagnostic(message: string): void { this.diagnostics.push(message); }
  forceExit(code: number): void { this.exits.push(code); }
}

function controller(components: readonly LifecycleComponent[]): AgentDeckCompositionController {
  const composition: AgentDeckComposition = {
    topology: 'standalone',
    role: 'standalone-host',
    components,
    client: null,
  };
  return new AgentDeckCompositionController(composition);
}

describe('headless service runner', () => {
  it('rolls back a partial startup in reverse order and returns a failure', async () => {
    const order: string[] = [];
    const processPort = new FakeProcess();
    const target = controller([
      { name: 'first', start: async () => { order.push('start:first'); }, stop: async () => { order.push('stop:first'); } },
      { name: 'second', start: async () => { order.push('start:second'); throw new Error('boom'); }, stop: vi.fn() },
    ]);

    await expect(runCompositionService(target, {}, processPort)).resolves.toEqual({
      reason: 'startup-failed',
      exitCode: 1,
    });
    expect(order).toEqual(['start:first', 'start:second', 'stop:first']);
    expect(processPort.listeners.get('SIGTERM')?.size).toBe(0);
  });

  it('coalesces signals received during startup into one bounded shutdown', async () => {
    let release!: () => void;
    const starting = new Promise<void>((resolve) => { release = resolve; });
    const stop = vi.fn(async () => undefined);
    const processPort = new FakeProcess();
    const run = runCompositionService(controller([
      { name: 'slow', start: () => starting, stop },
    ]), { startupTimeoutMs: 1_000, shutdownTimeoutMs: 1_000 }, processPort);
    processPort.emit('SIGTERM');
    processPort.emit('SIGINT');
    release();

    await expect(run).resolves.toEqual({ reason: 'signal:SIGTERM', exitCode: 0 });
    expect(stop).toHaveBeenCalledTimes(1);
    expect(stop).toHaveBeenCalledWith('signal:SIGTERM');
  });

  it('forces a redacted failure result when shutdown exceeds its bound', async () => {
    const processPort = new FakeProcess();
    const run = runCompositionService(controller([{
      name: 'stuck',
      start: async () => undefined,
      stop: () => new Promise<void>(() => undefined),
    }]), { shutdownTimeoutMs: 5 }, processPort);
    await vi.waitFor(() => expect(processPort.listeners.get('SIGINT')?.size).toBe(1));
    processPort.emit('SIGINT');
    await expect(run).resolves.toEqual({ reason: 'signal:SIGINT', exitCode: 1 });
    expect(processPort.exits).toEqual([1]);
    expect(processPort.diagnostics.join('\n')).not.toContain('stuck');
  });

  it('bounds a startup that never settles and then bounds its rollback wait', async () => {
    const processPort = new FakeProcess();
    const run = runCompositionService(controller([{
      name: 'never-started',
      start: () => new Promise<void>(() => undefined),
      stop: async () => undefined,
    }]), { startupTimeoutMs: 5, shutdownTimeoutMs: 5 }, processPort);

    await expect(run).resolves.toEqual({ reason: 'startup-failed', exitCode: 1 });
    expect(processPort.exits).toEqual([1]);
  });
});
