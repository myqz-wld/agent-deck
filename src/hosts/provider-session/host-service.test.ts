import { describe, expect, it, vi } from 'vitest';

import type { ServiceProcessPort, ServiceSignal } from '@hosts/linux-runtime/service-runner';

import {
  runProviderSessionSupervisorService,
  type ProviderSessionSupervisorServicePort,
} from './host-service';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((accept) => { resolve = accept; });
  return { promise, resolve };
}

function processPort() {
  const listeners = new Map<ServiceSignal, () => void>();
  const port: ServiceProcessPort = {
    on: (signal, listener) => { listeners.set(signal, listener); },
    off: (signal, listener) => {
      if (listeners.get(signal) === listener) listeners.delete(signal);
    },
    writeDiagnostic: vi.fn(),
    forceExit: vi.fn(),
  };
  return { listeners, port };
}

function service(
  closeRequested: Promise<void>,
  failed: Promise<Error>,
): ProviderSessionSupervisorServicePort & { start: ReturnType<typeof vi.fn>; stop: ReturnType<typeof vi.fn> } {
  return {
    start: vi.fn(async () => undefined),
    stop: vi.fn(async () => undefined),
    whenCloseRequested: () => closeRequested,
    whenFailed: () => failed,
  };
}

describe('Provider supervisor host service lifecycle', () => {
  it('retires after the Core close response and performs one bounded stop', async () => {
    const close = deferred<void>();
    const failure = deferred<Error>();
    const fake = service(close.promise, failure.promise);
    const process = processPort();
    const running = runProviderSessionSupervisorService(fake, {}, process.port);
    await vi.waitFor(() => expect(fake.start).toHaveBeenCalledOnce());
    close.resolve();
    await expect(running).resolves.toEqual({ exitCode: 0, reason: 'core-close-requested' });
    expect(fake.stop).toHaveBeenCalledOnce();
    expect(process.listeners.size).toBe(0);
  });

  it('fails closed on listener failure and still retires the supervisor', async () => {
    const close = deferred<void>();
    const failure = deferred<Error>();
    const fake = service(close.promise, failure.promise);
    const process = processPort();
    const running = runProviderSessionSupervisorService(fake, {}, process.port);
    failure.resolve(new Error('listener failed'));
    await expect(running).resolves.toEqual({ exitCode: 1, reason: 'listener-failed' });
    expect(fake.stop).toHaveBeenCalledOnce();
    expect(process.port.writeDiagnostic).toHaveBeenCalledWith(
      'Provider supervisor 私有监听器失败（listener-failed）；请运行 health-config 并检查服务状态。',
    );
  });

  it('reports an actionable startup stage without leaking the rejected cause', async () => {
    const never = new Promise<never>(() => undefined);
    const fake = service(never, never);
    fake.start.mockRejectedValueOnce(new Error('secret path'));
    const process = processPort();
    await expect(runProviderSessionSupervisorService(
      fake,
      { startupTimeoutMs: 100, shutdownTimeoutMs: 100 },
      process.port,
    )).resolves.toEqual({ exitCode: 1, reason: 'startup-failed' });
    expect(fake.stop).toHaveBeenCalledOnce();
    expect(process.port.writeDiagnostic).toHaveBeenCalledWith(
      'Provider supervisor 启动阶段失败（startup-failed）；请先运行 check-config 和 prepare-runtime，再检查 OCI executable、socket 与固定镜像。',
    );
    expect(JSON.stringify(vi.mocked(process.port.writeDiagnostic).mock.calls))
      .not.toContain('secret path');
  });
});
