import { normalizeGrokSandboxProfile } from '@shared/grok-sandbox';

import { errorText } from './protocol-utils';
import type { GrokRuntime } from './runtime-types';

interface RestartInFlight {
  target: string | null;
  promise: Promise<string>;
}

interface GrokSandboxRestartContext {
  getRuntime: (sessionId: string) => GrokRuntime | null;
  start: (runtime: GrokRuntime) => Promise<boolean>;
  drain: (runtime: GrokRuntime) => Promise<void>;
  dispose: (runtime: GrokRuntime) => Promise<void>;
  persist: (runtime: GrokRuntime) => void;
}

/**
 * Grok's sandbox is fixed when the ACP child starts. This controller swaps only that child while
 * preserving the Agent Deck runtime, native session, queue, MCP token, and SDK ownership claim.
 */
export class GrokSandboxRestartController {
  private readonly inFlight = new Map<string, RestartInFlight>();

  constructor(private readonly context: GrokSandboxRestartContext) {}

  restart(sessionId: string, requested: string | null): Promise<string> {
    const target =
      requested === null ? null : normalizeGrokSandboxProfile(requested);
    const current = this.inFlight.get(sessionId);
    if (current) {
      if (current.target === target) return current.promise;
      return Promise.reject(
        new Error('Grok 沙盒正在切换中，请等待当前切换完成后再选择其他档位。'),
      );
    }

    const runtime = this.context.getRuntime(sessionId);
    if (!runtime?.process || !runtime.ready || runtime.closed || runtime.disposed) {
      return Promise.reject(new Error(`Grok session ${sessionId} is not active.`));
    }
    const previousSelection = runtime.grokSandbox;
    if (previousSelection !== target) {
      runtime.grokSandbox = target;
      try {
        this.context.persist(runtime);
      } catch (error) {
        runtime.grokSandbox = previousSelection;
        return Promise.reject(error);
      }
    }
    if (runtime.activeGrokSandbox === target) return Promise.resolve(sessionId);
    if (this.mustWaitForTurnBoundary(runtime)) return Promise.resolve(sessionId);

    return this.beginRestart(runtime, target, true);
  }

  async applyBeforeNextTurn(runtime: GrokRuntime): Promise<void> {
    if (runtime.grokSandbox === runtime.activeGrokSandbox) return;
    await this.beginRestart(runtime, runtime.grokSandbox, false);
  }

  private beginRestart(
    runtime: GrokRuntime,
    target: string | null,
    drainAfter: boolean,
  ): Promise<string> {
    const sessionId = runtime.applicationSessionId;
    const current = this.inFlight.get(sessionId);
    if (current) {
      if (current.target === target) return current.promise;
      return Promise.reject(
        new Error('Grok 沙盒正在切换中，请等待当前切换完成后再选择其他档位。'),
      );
    }
    const promise = this.restartRuntime(runtime, target).finally(() => {
      const active = this.inFlight.get(sessionId);
      if (active?.promise === promise) this.inFlight.delete(sessionId);
      if (drainAfter) void this.context.drain(runtime);
    });
    this.inFlight.set(sessionId, { target, promise });
    return promise;
  }

  private async restartRuntime(
    runtime: GrokRuntime,
    target: string | null,
  ): Promise<string> {
    this.assertIdle(runtime);
    const oldProfile = runtime.activeGrokSandbox;
    runtime.restartingSandbox = true;
    runtime.ready = false;
    runtime.suppressUpdates = true;

    const oldProcess = runtime.process;
    if (!oldProcess) {
      runtime.restartingSandbox = false;
      throw new Error(`Grok session ${runtime.applicationSessionId} lost its ACP process.`);
    }
    try {
      await oldProcess.stop();
      if (runtime.process === oldProcess) runtime.process = null;
    } catch (stopError) {
      const persistError = this.restoreSelection(runtime, oldProfile);
      await this.disposeAfterUnprovenStop(runtime);
      throw new Error(
        `旧 Grok ACP 进程停止失败，无法安全切换沙盒；会话已释放：${errorText(
          stopError,
        )}${persistError ? `；旧档位持久化失败：${errorText(persistError)}` : ''}`,
        { cause: stopError },
      );
    }

    let targetError: unknown;
    try {
      runtime.grokSandbox = target;
      if (!(await this.context.start(runtime))) {
        throw new Error('Grok session closed before sandbox restart completed.');
      }
      runtime.activeGrokSandbox = target;
      this.context.persist(runtime);
      runtime.restartingSandbox = false;
      return runtime.applicationSessionId;
    } catch (error) {
      targetError = error;
      try {
        await this.stopCurrentProcess(runtime);
      } catch (stopError) {
        const persistError = this.restoreSelection(runtime, oldProfile);
        await this.disposeAfterUnprovenStop(runtime);
        throw new Error(
          `目标 Grok ACP 进程停止失败，无法安全启动旧档位；会话已释放。` +
            `切换错误：${errorText(targetError)}；停止错误：${errorText(stopError)}` +
            `${persistError ? `；旧档位持久化失败：${errorText(persistError)}` : ''}`,
          { cause: targetError },
        );
      }
    }

    try {
      runtime.grokSandbox = oldProfile;
      if (!(await this.context.start(runtime))) {
        throw new Error('Grok session closed before sandbox rollback completed.');
      }
      runtime.activeGrokSandbox = oldProfile;
      this.context.persist(runtime);
      runtime.restartingSandbox = false;
      throw new GrokSandboxSwitchRolledBackError(target, targetError);
    } catch (rollbackError) {
      if (rollbackError instanceof GrokSandboxSwitchRolledBackError) {
        throw rollbackError;
      }
      try {
        await this.stopCurrentProcess(runtime);
      } catch (stopError) {
        const persistError = this.restoreSelection(runtime, oldProfile);
        await this.disposeAfterUnprovenStop(runtime);
        throw new Error(
          `回滚 Grok ACP 进程停止失败，运行状态无法确认；会话已释放。` +
            `切换错误：${errorText(targetError)}；恢复错误：${errorText(
              rollbackError,
            )}；停止错误：${errorText(stopError)}` +
            `${persistError ? `；旧档位持久化失败：${errorText(persistError)}` : ''}`,
          { cause: targetError },
        );
      }
      const persistError = this.restoreSelection(runtime, oldProfile);
      runtime.restartingSandbox = false;
      await this.context.dispose(runtime);
      throw new Error(
        `Grok 沙盒切换失败，旧档位恢复也失败。切换错误：${errorText(
          targetError,
        )}；恢复错误：${errorText(rollbackError)}` +
          `${persistError ? `；旧档位持久化失败：${errorText(persistError)}` : ''}`,
        { cause: targetError },
      );
    }
  }

  private mustWaitForTurnBoundary(runtime: GrokRuntime): boolean {
    return (
      runtime.running ||
      runtime.submittingMessage != null ||
      runtime.pendingPermissions.size > 0 ||
      runtime.runtimeMutationInProgress === true ||
      runtime.cwdTransitionGeneration != null
    );
  }

  private assertIdle(runtime: GrokRuntime): void {
    if (
      runtime.running ||
      runtime.submittingMessage != null ||
      runtime.pendingPermissions.size > 0 ||
      runtime.runtimeMutationInProgress ||
      runtime.cwdTransitionGeneration != null
    ) {
      throw new Error(
        '当前 Grok turn 或授权请求尚未结束，或 runtime 设置事务仍在进行；请等待会话空闲后再切换沙盒。',
      );
    }
  }

  private async stopCurrentProcess(runtime: GrokRuntime): Promise<void> {
    runtime.ready = false;
    const process = runtime.process;
    if (process) await process.stop();
    if (runtime.process === process) runtime.process = null;
  }

  private restoreSelection(runtime: GrokRuntime, profile: string | null): unknown {
    runtime.grokSandbox = profile;
    try {
      this.context.persist(runtime);
      return null;
    } catch (error) {
      return error;
    }
  }

  private async disposeAfterUnprovenStop(runtime: GrokRuntime): Promise<void> {
    runtime.restartingSandbox = false;
    try {
      await this.context.dispose(runtime);
    } catch {
      // The lifecycle coordinator marks the runtime disposed before awaiting process.stop().
    }
  }
}

class GrokSandboxSwitchRolledBackError extends Error {
  constructor(target: string | null, cause: unknown) {
    super(
      `Grok 沙盒切换到“${target ?? '跟随原生配置'}”失败，已恢复原档位：${errorText(cause)}`,
      { cause },
    );
    this.name = 'GrokSandboxSwitchRolledBackError';
  }
}
