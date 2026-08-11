import { errorText } from './protocol-utils';
import type { GrokRuntime } from './runtime-types';
import {
  NOOP_GROK_BRIDGE_DIAGNOSTICS,
  type GrokBridgeDiagnostics,
} from './bridge-diagnostics-core';

export interface GrokTransportRecoveryContext {
  diagnostics?: GrokBridgeDiagnostics;
  isCurrent: (runtime: GrokRuntime) => boolean;
  start: (runtime: GrokRuntime) => Promise<boolean>;
  persist: (runtime: GrokRuntime) => void;
  dispose: (runtime: GrokRuntime) => Promise<void>;
  emitTerminalError: (sessionId: string, text: string) => void;
}

/**
 * Replace an ACP child that missed a provider-completed turn while preserving the application
 * session, native session id, pending FIFO, MCP ownership, and runtime settings.
 */
export async function recycleGrokTransport(
  runtime: GrokRuntime,
  context: GrokTransportRecoveryContext,
): Promise<void> {
  const logger = (context.diagnostics ?? NOOP_GROK_BRIDGE_DIAGNOSTICS)
    .scope('grok-transport-recovery');
  if (!context.isCurrent(runtime) || runtime.closed) return;
  runtime.ready = false;
  runtime.suppressUpdates = true;
  const oldProcess = runtime.process;

  try {
    if (oldProcess) await oldProcess.stop();
    if (runtime.process === oldProcess) runtime.process = null;
    if (!context.isCurrent(runtime) || runtime.closed) return;
    if (!(await context.start(runtime))) {
      throw new Error('Grok session closed before ACP transport recovery completed.');
    }
    context.persist(runtime);
    logger.info('[grok-transport-recovery] ACP transport recycled', {
      event: 'grok_transport_recovery',
      sessionId: runtime.applicationSessionId,
      nativeSessionId: runtime.nativeSessionId,
      processPid: runtime.process?.pid ?? null,
    });
  } catch (error) {
    logger.warn('[grok-transport-recovery] ACP transport recycle failed', {
      event: 'grok_transport_recovery',
      sessionId: runtime.applicationSessionId,
      nativeSessionId: runtime.nativeSessionId,
      error: errorText(error),
    });
    if (context.isCurrent(runtime) && !runtime.closed) {
      context.emitTerminalError(
        runtime.applicationSessionId,
        `Grok 回复已从原生记录恢复，但 ACP 连接重建失败：${errorText(error)}。` +
          '请重新发送下一条消息以恢复 session。',
      );
    }
    try {
      await context.dispose(runtime);
    } catch {
      // The lifecycle coordinator marks the runtime disposed before stopping its child.
    }
  }
}
