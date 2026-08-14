import type { FeishuGatewayRuntimePort } from '@gateways/feishu';

export type FeishuServiceSignal = 'SIGINT' | 'SIGTERM';

export interface FeishuServiceProcessPort {
  on(signal: FeishuServiceSignal, listener: () => void): void;
  off(signal: FeishuServiceSignal, listener: () => void): void;
}

export interface FeishuServiceResult {
  readonly reason: 'fatal' | FeishuServiceSignal;
  readonly exitCode: 0 | 1;
}

export interface FeishuServiceControlPort {
  start(): Promise<void>;
  close(): Promise<void>;
}

const SYSTEM_PROCESS: FeishuServiceProcessPort = {
  on: (signal, listener) => process.on(signal, listener),
  off: (signal, listener) => process.off(signal, listener),
};

export async function runFeishuService<T extends FeishuGatewayRuntimePort>(
  createRuntime: (onFatal: () => void) => T,
  processPort: FeishuServiceProcessPort = SYSTEM_PROCESS,
  createControl?: (runtime: T, onFatal: () => void) => FeishuServiceControlPort,
): Promise<FeishuServiceResult> {
  let resolveTerminal!: (reason: FeishuServiceResult['reason']) => void;
  let terminalReason: FeishuServiceResult['reason'] | null = null;
  const terminal = new Promise<FeishuServiceResult['reason']>((resolve) => {
    resolveTerminal = resolve;
  });
  const requestTerminal = (reason: FeishuServiceResult['reason']): void => {
    if (terminalReason !== null) return;
    terminalReason = reason;
    resolveTerminal(reason);
  };
  const onSigint = (): void => requestTerminal('SIGINT');
  const onSigterm = (): void => requestTerminal('SIGTERM');
  processPort.on('SIGINT', onSigint);
  processPort.on('SIGTERM', onSigterm);
  let runtime: FeishuGatewayRuntimePort | null = null;
  let control: FeishuServiceControlPort | null = null;
  try {
    runtime = createRuntime(() => requestTerminal('fatal'));
    await runtime.start();
    control = createControl?.(runtime as T, () => requestTerminal('fatal')) ?? null;
    await control?.start();
    const reason = await terminal;
    const closed = await Promise.allSettled([control?.close(), runtime.close()]);
    if (closed.some((result) => result.status === 'rejected')) {
      throw new Error('Feishu service cleanup failed');
    }
    return { reason, exitCode: reason === 'fatal' ? 1 : 0 };
  } catch (error) {
    try {
      await control?.close();
    } catch {
      // Runtime cleanup below remains mandatory.
    }
    try {
      await runtime?.close();
    } catch {
      // The fixed startup/cleanup failure remains authoritative to the entrypoint.
    }
    throw error;
  } finally {
    processPort.off('SIGINT', onSigint);
    processPort.off('SIGTERM', onSigterm);
  }
}
