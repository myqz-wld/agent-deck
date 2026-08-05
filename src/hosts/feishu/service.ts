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

const SYSTEM_PROCESS: FeishuServiceProcessPort = {
  on: (signal, listener) => process.on(signal, listener),
  off: (signal, listener) => process.off(signal, listener),
};

export async function runFeishuService(
  createRuntime: (onFatal: () => void) => FeishuGatewayRuntimePort,
  processPort: FeishuServiceProcessPort = SYSTEM_PROCESS,
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
  try {
    runtime = createRuntime(() => requestTerminal('fatal'));
    await runtime.start();
    const reason = await terminal;
    await runtime.close();
    return { reason, exitCode: reason === 'fatal' ? 1 : 0 };
  } catch (error) {
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
