import { randomUUID } from 'node:crypto';

import type {
  ServiceProcessPort,
  ServiceRunOptions,
  ServiceRunResult,
} from '@hosts/linux-runtime/service-runner';

import type { ProviderSessionSupervisorHostConfig } from './host-config';
import { createProductionProviderSessionSupervisorHost } from './production';
import type { ProviderSessionSupervisorTransportServer } from './supervisor-transport-server';

export interface ProviderSessionSupervisorServicePort {
  start(): Promise<void>;
  stop(): Promise<void>;
  whenCloseRequested(): Promise<void>;
  whenFailed(): Promise<Error>;
}

const DEFAULT_PROCESS: ServiceProcessPort = Object.freeze({
  on: (signal, listener) => process.on(signal, listener),
  off: (signal, listener) => process.off(signal, listener),
  writeDiagnostic: (message) => process.stderr.write(`${message}\n`),
  forceExit: (code) => process.exit(code),
});

function bounded(value: number | undefined, fallback: number, field: string): number {
  const resolved = value ?? fallback;
  if (!Number.isSafeInteger(resolved) || resolved < 1 || resolved > 600_000) {
    throw new Error(`${field} is invalid`);
  }
  return resolved;
}

function deadline<T>(operation: Promise<T>, delayMs: number, label: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${label} timed out`)), delayMs);
    timer.unref();
    void operation.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

/** Converts one validated private config into the host-only production supervisor. */
export function createProviderSessionSupervisorHost(
  config: ProviderSessionSupervisorHostConfig,
  coreProcessId = `provider-supervisor:${process.pid}:${randomUUID()}`,
): ProviderSessionSupervisorTransportServer {
  return createProductionProviderSessionSupervisorHost({
    brokerRoot: config.brokerRoot,
    coreProcessId,
    desktopSocketPath: config.desktopSocketPath ?? undefined,
    desktopVm: config.desktopVm ?? undefined,
    engine: config.engine,
    executable: config.executable,
    images: config.images,
    instanceId: config.instanceId,
    maxActive: config.maxActive,
    privateRoot: config.privateRoot,
    rootlessHome: config.rootlessHome ?? undefined,
    rootlessRuntimeDirectory: config.rootlessRuntimeDirectory ?? undefined,
    stateRoot: config.stateRoot,
    transportRuntimeDirectory: config.transportRuntimeDirectory,
    transportSocketPath: config.transportSocketPath,
    workspaceRoot: config.workspaceRoot,
  });
}

/**
 * Owns the standalone host service lifecycle. A successful Core close RPC terminates the service
 * after its response is flushed; listener failure exits non-zero instead of leaving stale health.
 */
export async function runProviderSessionSupervisorService(
  service: ProviderSessionSupervisorServicePort,
  options: ServiceRunOptions = {},
  processPort: ServiceProcessPort = DEFAULT_PROCESS,
): Promise<ServiceRunResult> {
  const startupTimeoutMs = bounded(options.startupTimeoutMs, 120_000, 'startupTimeoutMs');
  const shutdownTimeoutMs = bounded(options.shutdownTimeoutMs, 120_000, 'shutdownTimeoutMs');
  let resolveSignal!: (reason: string) => void;
  const signal = new Promise<string>((resolve) => { resolveSignal = resolve; });
  let signaled = false;
  const signalOnce = (reason: string): void => {
    if (signaled) return;
    signaled = true;
    resolveSignal(reason);
  };
  const onSigint = (): void => signalOnce('signal:SIGINT');
  const onSigterm = (): void => signalOnce('signal:SIGTERM');
  processPort.on('SIGINT', onSigint);
  processPort.on('SIGTERM', onSigterm);

  let reason = 'startup-failed';
  let exitCode: 0 | 1 = 0;
  let startupComplete = false;
  try {
    await deadline(service.start(), startupTimeoutMs, 'Provider supervisor startup');
    startupComplete = true;
    const terminal = await Promise.race([
      signal.then((value) => ({ kind: 'signal' as const, reason: value })),
      service.whenCloseRequested().then(() => ({
        kind: 'close' as const,
        reason: 'core-close-requested',
      })),
      service.whenFailed().then(() => ({
        kind: 'failure' as const,
        reason: 'listener-failed',
      })),
    ]);
    reason = terminal.reason;
    if (terminal.kind === 'failure') {
      exitCode = 1;
      processPort.writeDiagnostic(
        'Provider supervisor 私有监听器失败（listener-failed）；请运行 health-config 并检查服务状态。',
      );
    }
  } catch {
    exitCode = 1;
    processPort.writeDiagnostic(startupComplete
      ? 'Provider supervisor 运行阶段失败（runtime-failed）；请运行 health-config 并检查服务状态。'
      : 'Provider supervisor 启动阶段失败（startup-failed）；请先运行 check-config 和 prepare-runtime，再检查 OCI executable、socket 与固定镜像。');
  } finally {
    try {
      await deadline(service.stop(), shutdownTimeoutMs, 'Provider supervisor shutdown');
    } catch {
      exitCode = 1;
      processPort.writeDiagnostic('Provider supervisor 未能在时限内安全停止。');
      processPort.forceExit(1);
    }
    processPort.off('SIGINT', onSigint);
    processPort.off('SIGTERM', onSigterm);
  }
  return Object.freeze({ exitCode, reason });
}
