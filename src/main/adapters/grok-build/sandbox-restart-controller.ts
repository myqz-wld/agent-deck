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
    if (!runtime?.process || !runtime.ready || runtime.closed) {
      return Promise.reject(new Error(`Grok session ${sessionId} is not active.`));
    }
    if (runtime.grokSandbox === target) return Promise.resolve(sessionId);

    const promise = this.restartRuntime(runtime, target).finally(() => {
      const active = this.inFlight.get(sessionId);
      if (active?.promise === promise) this.inFlight.delete(sessionId);
    });
    this.inFlight.set(sessionId, { target, promise });
    return promise;
  }

  private async restartRuntime(
    runtime: GrokRuntime,
    target: string | null,
  ): Promise<string> {
    this.assertIdle(runtime);
    const oldProfile = runtime.grokSandbox;
    runtime.restartingSandbox = true;
    runtime.ready = false;
    runtime.suppressUpdates = true;

    const oldProcess = runtime.process;
    if (!oldProcess) {
      runtime.restartingSandbox = false;
      throw new Error(`Grok session ${runtime.applicationSessionId} lost its ACP process.`);
    }
    runtime.process = null;
    await oldProcess.stop();

    let targetError: unknown;
    try {
      runtime.grokSandbox = target;
      if (!(await this.context.start(runtime))) {
        throw new Error('Grok session closed before sandbox restart completed.');
      }
      this.context.persist(runtime);
      runtime.restartingSandbox = false;
      void this.context.drain(runtime);
      return runtime.applicationSessionId;
    } catch (error) {
      targetError = error;
      await this.stopCurrentProcess(runtime);
    }

    try {
      runtime.grokSandbox = oldProfile;
      if (!(await this.context.start(runtime))) {
        throw new Error('Grok session closed before sandbox rollback completed.');
      }
      this.context.persist(runtime);
      runtime.restartingSandbox = false;
      void this.context.drain(runtime);
      throw new GrokSandboxSwitchRolledBackError(target, targetError);
    } catch (rollbackError) {
      if (rollbackError instanceof GrokSandboxSwitchRolledBackError) {
        throw rollbackError;
      }
      await this.stopCurrentProcess(runtime);
      runtime.restartingSandbox = false;
      await this.context.dispose(runtime);
      throw new Error(
        `Grok 沙盒切换失败，旧档位恢复也失败。切换错误：${errorText(
          targetError,
        )}；恢复错误：${errorText(rollbackError)}`,
        { cause: targetError },
      );
    }
  }

  private assertIdle(runtime: GrokRuntime): void {
    if (
      runtime.running ||
      runtime.submittingMessage != null ||
      runtime.pendingPermissions.size > 0
    ) {
      throw new Error('当前 Grok turn 或授权请求尚未结束，请等待会话空闲后再切换沙盒。');
    }
  }

  private async stopCurrentProcess(runtime: GrokRuntime): Promise<void> {
    runtime.ready = false;
    const process = runtime.process;
    runtime.process = null;
    if (process) await process.stop();
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
