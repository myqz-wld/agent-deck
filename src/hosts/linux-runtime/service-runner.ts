import type { AgentDeckCompositionController } from '@composition/controller';

export type ServiceSignal = 'SIGINT' | 'SIGTERM';

export interface ServiceProcessPort {
  on(signal: ServiceSignal, listener: () => void): void;
  off(signal: ServiceSignal, listener: () => void): void;
  writeDiagnostic(message: string): void;
  forceExit(code: number): void;
}

export interface ServiceRunOptions {
  readonly startupTimeoutMs?: number;
  readonly shutdownTimeoutMs?: number;
}

export interface ServiceRunResult {
  readonly reason: string;
  readonly exitCode: 0 | 1;
}

const DEFAULT_PROCESS: ServiceProcessPort = {
  on: (signal, listener) => process.on(signal, listener),
  off: (signal, listener) => process.off(signal, listener),
  writeDiagnostic: (message) => process.stderr.write(`${message}\n`),
  forceExit: (code) => process.exit(code),
};

function bounded(value: number | undefined, fallback: number, field: string): number {
  const resolved = value ?? fallback;
  if (!Number.isSafeInteger(resolved) || resolved <= 0 || resolved > 600_000) {
    throw new RangeError(`${field} must be between 1 and 600000 milliseconds`);
  }
  return resolved;
}

function deadline<T>(
  promise: Promise<T>,
  delayMs: number,
  label: string,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${label} timed out`)), delayMs);
    void promise.then(
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

/** Installs signal handlers before startup and coalesces every terminal path into one shutdown. */
export async function runCompositionService(
  controller: AgentDeckCompositionController,
  options: ServiceRunOptions = {},
  processPort: ServiceProcessPort = DEFAULT_PROCESS,
): Promise<ServiceRunResult> {
  const startupTimeoutMs = bounded(options.startupTimeoutMs, 120_000, 'startupTimeoutMs');
  const shutdownTimeoutMs = bounded(options.shutdownTimeoutMs, 60_000, 'shutdownTimeoutMs');
  let terminalReason: string | null = null;
  let resolveTerminal!: (reason: string) => void;
  const terminal = new Promise<string>((resolve) => {
    resolveTerminal = resolve;
  });
  const requestTerminal = (reason: string): void => {
    if (terminalReason !== null) return;
    terminalReason = reason;
    resolveTerminal(reason);
  };
  const onSigint = (): void => requestTerminal('signal:SIGINT');
  const onSigterm = (): void => requestTerminal('signal:SIGTERM');
  processPort.on('SIGINT', onSigint);
  processPort.on('SIGTERM', onSigterm);

  let exitCode: 0 | 1 = 0;
  try {
    try {
      await deadline(controller.start(), startupTimeoutMs, 'composition startup');
    } catch {
      exitCode = 1;
      requestTerminal('startup-failed');
    }
    const reason = await terminal;
    try {
      await deadline(controller.stop(reason), shutdownTimeoutMs, 'composition shutdown');
    } catch {
      exitCode = 1;
      processPort.writeDiagnostic('Agent Deck 无界面服务未能在时限内安全停止。');
      processPort.forceExit(1);
    }
    return { reason, exitCode };
  } finally {
    processPort.off('SIGINT', onSigint);
    processPort.off('SIGTERM', onSigterm);
  }
}
