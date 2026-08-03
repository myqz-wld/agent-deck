import { methods } from '@agentclientprotocol/sdk';
import * as mcpSessionTokenMap from '@main/agent-deck-mcp/mcp-session-token-map';
import { sessionManager } from '@main/session/manager';
import type { GrokPermissionController } from './permission-controller';
import type { GrokRuntime } from './runtime-types';
import { clearGrokTurnLiveRate } from './translate';

export class GrokRuntimeLifecycleCoordinator {
  constructor(
    private readonly runtimes: Map<string, GrokRuntime>,
    private readonly permissionController: GrokPermissionController,
    private readonly cancelSubmittingInterjection: (runtime: GrokRuntime) => void,
  ) {}

  isCurrent(runtime: GrokRuntime): boolean {
    return this.runtimes.get(runtime.applicationSessionId) === runtime;
  }

  async interrupt(sessionId: string): Promise<void> {
    const runtime = this.runtimes.get(sessionId);
    if (!runtime) throw new Error('Grok Build 会话不在运行中，无法中断。');
    this.cancelSubmittingInterjection(runtime);
    if (!runtime.process || !runtime.nativeSessionId || !runtime.running) {
      throw new Error('Grok Build 当前没有可中断的 active turn。');
    }
    runtime.interruptRequested = true;
    const controller = runtime.currentTurnController;
    try {
      await runtime.process.connection.agent.notify(methods.agent.session.cancel, {
        sessionId: runtime.nativeSessionId,
      });
    } finally {
      // ACP session/cancel asks the provider to stop model work. Aborting the matching JSON-RPC
      // request also sends $/cancelRequest and guarantees Agent Deck's pending prompt unwinds even
      // if Grok never returns a terminal response.
      controller?.abort();
      this.permissionController.cancel(runtime);
    }
  }

  async closeOrdinary(sessionId: string): Promise<void> {
    const runtime = this.runtimes.get(sessionId);
    if (!runtime) {
      mcpSessionTokenMap.release(sessionId);
      sessionManager.releaseSdkClaim(sessionId);
      return;
    }
    this.seal(runtime);
    await this.disposeOrdinary(runtime);
  }

  async closeForRollback(sessionId: string): Promise<void> {
    const runtime = this.runtimes.get(sessionId);
    if (!runtime) {
      throw new Error(`Grok rollback close cannot prove a live target runtime for ${sessionId}`);
    }
    this.seal(runtime);
    this.prepareDispose(runtime);
    const process = runtime.process;
    if (process) await process.stop();
    runtime.process = null;
    this.finishDispose(runtime);
  }

  retireAfterCurrentTurn(sessionId: string): void {
    const runtime = this.runtimes.get(sessionId);
    if (!runtime) return;
    runtime.sealed = true;
    runtime.queue.length = 0;
    if (!runtime.running) void this.closeOrdinary(sessionId);
  }

  async shutdownAll(): Promise<void> {
    await Promise.allSettled(
      [...this.runtimes.values()].map((runtime) => this.disposeOrdinary(runtime)),
    );
  }

  async disposeOrdinary(runtime: GrokRuntime): Promise<void> {
    if (runtime.disposed) return;
    this.prepareDispose(runtime);
    this.finishDispose(runtime);
    const process = runtime.process;
    runtime.process = null;
    if (process) await process.stop();
  }

  private seal(runtime: GrokRuntime): void {
    runtime.closed = true;
    runtime.sealed = true;
    runtime.queue.length = 0;
    runtime.submittingMessage?.requestController?.abort();
    runtime.submittingMessage = null;
    runtime.currentTurnController?.abort();
    runtime.currentTurnController = null;
  }

  private prepareDispose(runtime: GrokRuntime): void {
    runtime.closed = true;
    runtime.ready = false;
    runtime.runtimeIdentity = null;
    runtime.sealed = true;
    runtime.submittingMessage?.requestController?.abort();
    runtime.submittingMessage = null;
    runtime.currentTurnController?.abort();
    runtime.currentTurnController = null;
    clearGrokTurnLiveRate(runtime.translation);
    this.permissionController.cancel(runtime);
  }

  private finishDispose(runtime: GrokRuntime): void {
    runtime.disposed = true;
    if (!this.isCurrent(runtime)) return;
    this.runtimes.delete(runtime.applicationSessionId);
    mcpSessionTokenMap.release(runtime.applicationSessionId);
    sessionManager.releaseSdkClaim(runtime.applicationSessionId);
  }
}
