import type {
  AgentCwdTransition,
  AgentCwdTransitionSwitchResult,
} from '@main/adapters/types';
import type {
  CapturedRecoveryContinuation,
  PreparedRecoveryContinuation,
  RecoveryRuntimeOverrides,
} from '@main/session/continuation-context/recovery';
import { sessionRepo } from '@main/store/session-repo';
import type { SessionRecord } from '@shared/types';
import { isClaudeThinkingLevel } from '@shared/session-metadata';
import type { CreateSessionOpts } from './create-session/_deps';
import type {
  InternalSession,
  SdkSessionHandle,
} from './types';

interface ClaudeCwdTransitionContext {
  sessions: ReadonlyMap<string, InternalSession>;
  closeSession: (
    sessionId: string,
    options?: { markRecentlyDeleted?: boolean },
  ) => Promise<void>;
  createSession: (options: CreateSessionOpts) => Promise<SdkSessionHandle>;
  capture: (input: {
    session: SessionRecord;
    overrides?: RecoveryRuntimeOverrides;
  }) => CapturedRecoveryContinuation;
  prepare: (input: {
    capture: CapturedRecoveryContinuation;
    continuationInstruction: string;
  }) => Promise<PreparedRecoveryContinuation>;
  cleanup: (capture: CapturedRecoveryContinuation) => void;
}

export class ClaudeCwdTransitionController {
  constructor(private readonly context: ClaudeCwdTransitionContext) {}

  arm(transition: AgentCwdTransition): void {
    const internal = this.requireSession(transition.sessionId);
    const current = internal.cwdTransitionGeneration;
    if (current != null && current !== transition.generation) {
      throw new Error(
        `Claude session ${transition.sessionId} already has cwd transition generation ${current}.`,
      );
    }
    internal.cwdTransitionGeneration = transition.generation;
  }

  async switchCwd(
    transition: AgentCwdTransition,
  ): Promise<AgentCwdTransitionSwitchResult> {
    const current = this.requireArmed(transition);
    if (current.userTurnInFlight) {
      throw new Error(
        `Claude cwd transition ${transition.sessionId}:${transition.generation} reached switch before the active turn ended.`,
      );
    }
    if (current.cwd === transition.targetCwd) {
      return { continuationAccepted: false };
    }
    const record = sessionRepo.get(transition.sessionId);
    if (!record) throw new Error(`session ${transition.sessionId} not found`);

    const targetCapture = this.context.capture({
      session: record,
      overrides: { cwd: transition.targetCwd },
    });
    const sourceCapture = this.context.capture({
      session: record,
      overrides: { cwd: transition.fromCwd },
    });
    try {
      const target = await this.context.prepare({
        capture: targetCapture,
        continuationInstruction: transition.continuationText,
      });
      await this.context.closeSession(transition.sessionId, {
        markRecentlyDeleted: false,
      });
      try {
        await this.createAtCwd(
          transition,
          record,
          transition.targetCwd,
          target,
        );
        return { continuationAccepted: true };
      } catch (targetError) {
        const source = await this.context.prepare({
          capture: sourceCapture,
          continuationInstruction:
            'The working directory transition failed. Continue the current task from the restored original working directory.',
        });
        try {
          await this.createAtCwd(
            transition,
            record,
            transition.fromCwd,
            source,
          );
        } catch (rollbackError) {
          throw new Error(
            `Claude cwd 切换失败，旧 cwd 恢复也失败。切换错误：${errorText(
              targetError,
            )}；恢复错误：${errorText(rollbackError)}`,
            { cause: targetError },
          );
        }
        throw new Error(
          `Claude cwd 切换失败，已恢复 ${transition.fromCwd}：${errorText(
            targetError,
          )}`,
          { cause: targetError },
        );
      }
    } finally {
      this.context.cleanup(targetCapture);
      this.context.cleanup(sourceCapture);
    }
  }

  release(sessionId: string, generation: number): void {
    const internal = this.context.sessions.get(sessionId);
    if (!internal || internal.cwdTransitionGeneration !== generation) return;
    internal.cwdTransitionGeneration = null;
    internal.notify?.();
  }

  runtimeCwd(sessionId: string): string | null {
    return this.context.sessions.get(sessionId)?.cwd ?? null;
  }

  private async createAtCwd(
    transition: AgentCwdTransition,
    record: SessionRecord,
    cwd: string,
    prepared: PreparedRecoveryContinuation,
  ): Promise<void> {
    await this.context.createSession({
      cwd,
      trustedContinuation: prepared.turn,
      resume: transition.sessionId,
      resumeMode: 'fresh-cli-reuse-app',
      provider: record.runtimeProvider ?? undefined,
      claudeAgentName: record.agentProfileName ?? undefined,
      claudePluginDir: record.agentPluginDir ?? undefined,
      permissionMode: record.permissionMode ?? undefined,
      claudeCodeSandbox: record.claudeCodeSandbox ?? undefined,
      extraAllowWrite: record.extraAllowWrite ?? undefined,
      model: record.model ?? undefined,
      claudeCodeEffortLevel: isClaudeThinkingLevel(record.thinking)
        ? record.thinking
        : undefined,
      initialEnqueueOptions: {
        idempotencyKey: transition.continuationKey,
        userEventAlreadyPersisted: true,
        bypassWorktreeTransitionGuard: true,
      },
    });
    const replacement = this.requireSession(transition.sessionId);
    replacement.cwdTransitionGeneration = transition.generation;
  }

  private requireArmed(transition: AgentCwdTransition): InternalSession {
    const internal = this.requireSession(transition.sessionId);
    if (internal.cwdTransitionGeneration !== transition.generation) {
      throw new Error(
        `Claude cwd transition ${transition.sessionId}:${transition.generation} is not armed.`,
      );
    }
    return internal;
  }

  private requireSession(sessionId: string): InternalSession {
    const internal = this.context.sessions.get(sessionId);
    if (!internal) throw new Error(`Claude session ${sessionId} is not live.`);
    return internal;
  }
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
