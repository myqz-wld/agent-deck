import type { AgentCwdTransition } from '@main/adapters/types';
import { errorText } from './protocol-utils';
import type { GrokRuntime } from './runtime-types';
import type { GrokTurnQueue } from './turn-queue';

interface GrokCwdTransitionContext {
  getRuntime: (sessionId: string) => GrokRuntime | null;
  start: (runtime: GrokRuntime) => Promise<boolean>;
  dispose: (runtime: GrokRuntime) => Promise<void>;
  drain: (runtime: GrokRuntime) => Promise<void>;
  cancelPermissions: (runtime: GrokRuntime) => void;
  turnQueue: GrokTurnQueue;
}

export class GrokCwdTransitionController {
  constructor(private readonly context: GrokCwdTransitionContext) {}

  arm(transition: AgentCwdTransition): void {
    const runtime = this.requireRuntime(transition.sessionId);
    const current = runtime.cwdTransitionGeneration;
    if (current != null && current !== transition.generation) {
      throw new Error(
        `Grok session ${transition.sessionId} already has cwd transition generation ${current}.`,
      );
    }
    const submitting = runtime.submittingMessage;
    if (
      submitting?.kind === 'interject' &&
      submitting.status !== 'cancelled'
    ) {
      submitting.status = 'cancelled';
      submitting.requestController?.abort();
      if (runtime.submittingMessage === submitting) {
        runtime.submittingMessage = null;
      }
      submitting.message.deferUserEventUntilTurnStart = true;
      runtime.queue.unshift(submitting.message);
    }
    runtime.cwdTransitionGeneration = transition.generation;
  }

  async switchCwd(transition: AgentCwdTransition): Promise<void> {
    const runtime = this.requireArmed(transition);
    this.context.cancelPermissions(runtime);
    this.assertIdle(runtime);
    const sourceCwd = runtime.cwd;
    if (sourceCwd === transition.targetCwd) return;
    runtime.runtimeMutationInProgress = true;
    runtime.ready = false;
    runtime.suppressUpdates = true;
    const sourceProcess = runtime.process;
    if (!sourceProcess) {
      runtime.runtimeMutationInProgress = false;
      throw new Error(`Grok session ${transition.sessionId} lost its ACP process.`);
    }
    try {
      await sourceProcess.stop();
      if (runtime.process === sourceProcess) runtime.process = null;
    } catch (error) {
      runtime.runtimeMutationInProgress = false;
      await this.disposeUnknown(runtime);
      throw new Error(
        `旧 Grok ACP 进程停止结果无法确认，cwd 未切换：${errorText(error)}`,
        { cause: error },
      );
    }

    let targetError: unknown;
    try {
      runtime.cwd = transition.targetCwd;
      if (!(await this.context.start(runtime))) {
        throw new Error('Grok session closed before cwd reload completed.');
      }
      runtime.runtimeMutationInProgress = false;
      return;
    } catch (error) {
      targetError = error;
      try {
        await this.stopCurrent(runtime);
      } catch (stopError) {
        runtime.runtimeMutationInProgress = false;
        await this.disposeUnknown(runtime);
        throw new Error(
          `Grok 目标 cwd runtime 启动失败，且半启动进程停止结果无法确认。` +
            `切换错误：${errorText(targetError)}；停止错误：${errorText(stopError)}`,
          { cause: targetError },
        );
      }
    }

    try {
      runtime.cwd = sourceCwd;
      if (!(await this.context.start(runtime))) {
        throw new Error('Grok session closed before cwd rollback completed.');
      }
      runtime.runtimeMutationInProgress = false;
      throw new Error(
        `Grok cwd 切换失败，已恢复 ${sourceCwd}：${errorText(targetError)}`,
        { cause: targetError },
      );
    } catch (rollbackError) {
      if (
        rollbackError instanceof Error &&
        rollbackError.message.startsWith('Grok cwd 切换失败，已恢复')
      ) {
        throw rollbackError;
      }
      runtime.runtimeMutationInProgress = false;
      await this.disposeUnknown(runtime);
      throw new Error(
        `Grok cwd 切换失败，旧 cwd 恢复也失败。切换错误：${errorText(
          targetError,
        )}；恢复错误：${errorText(rollbackError)}`,
        { cause: targetError },
      );
    }
  }

  enqueueContinuation(
    transition: AgentCwdTransition,
    text: string,
  ): void {
    const runtime = this.requireArmed(transition);
    const before = runtime.queue.length;
    this.context.turnQueue.enqueue(runtime, text, undefined, {
      idempotencyKey: transition.continuationKey,
      bypassQueueLimit: true,
      userEventAlreadyPersisted: true,
      bypassWorktreeTransitionGuard: true,
    });
    if (runtime.queue.length === before + 1) {
      const queued = runtime.queue.pop()!;
      runtime.queue.unshift(queued);
    }
  }

  release(sessionId: string, generation: number): void {
    const runtime = this.context.getRuntime(sessionId);
    if (!runtime || runtime.cwdTransitionGeneration !== generation) return;
    runtime.cwdTransitionGeneration = null;
    if (!runtime.running) void this.context.drain(runtime);
  }

  runtimeCwd(sessionId: string): string | null {
    return this.context.getRuntime(sessionId)?.cwd ?? null;
  }

  private assertIdle(runtime: GrokRuntime): void {
    if (
      runtime.running ||
      runtime.submittingMessage != null ||
      runtime.pendingPermissions.size > 0 ||
      runtime.restartingSandbox ||
      runtime.runtimeMutationInProgress
    ) {
      throw new Error(
        'Grok turn、授权请求或 runtime 设置事务尚未结束，无法确认 cwd 切换边界。',
      );
    }
  }

  private requireArmed(transition: AgentCwdTransition): GrokRuntime {
    const runtime = this.requireRuntime(transition.sessionId);
    if (runtime.cwdTransitionGeneration !== transition.generation) {
      throw new Error(
        `Grok cwd transition ${transition.sessionId}:${transition.generation} is not armed.`,
      );
    }
    return runtime;
  }

  private requireRuntime(sessionId: string): GrokRuntime {
    const runtime = this.context.getRuntime(sessionId);
    if (!runtime || runtime.closed || runtime.disposed) {
      throw new Error(`Grok session ${sessionId} is not live.`);
    }
    return runtime;
  }

  private async stopCurrent(runtime: GrokRuntime): Promise<void> {
    const process = runtime.process;
    runtime.ready = false;
    if (process) await process.stop();
    if (runtime.process === process) runtime.process = null;
  }

  private async disposeUnknown(runtime: GrokRuntime): Promise<void> {
    try {
      await this.context.dispose(runtime);
    } catch {
      // Disposal marks ownership closed before awaiting the process stop.
    }
  }
}
