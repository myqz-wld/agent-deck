import { adapterRegistry } from '@main/adapters/registry';
import type { AgentAdapter } from '@main/adapters/types';
import { sessionRepo } from '@main/store/session-repo';
import {
  worktreeTransitionRepo,
  WorktreeTransitionConflictError,
} from '@main/store/worktree-transition-repo';
import type {
  AgentEvent,
  SessionAdapterId,
} from '@shared/types';
import { cleanupStructuredWorktree } from './git-cleanup';
import {
  worktreeToolInvocationRegistry,
} from './tool-invocation-registry';
import type {
  WorktreeTransitionDirection,
  WorktreeTransitionRecord,
} from './types';
import { resolve } from 'node:path';
import {
  emitWorktreeSessionUpsert,
  emitWorktreeTransitionStatus,
} from './projection';
import {
  abortFailedEnterAtOriginalCwd,
  completeAcknowledgedEnter,
  completeAcknowledgedExit,
  recoverWorktreeTransition,
  restoreFailedExitAtWorktree,
} from './recovery';
import {
  compensateTransitionRuntime,
  deliverTransitionWork,
  replayAbortedTransitionInputs,
  toAgentCwdTransition,
} from './transition-delivery';

export { WORKTREE_TRANSITION_CONTINUATION } from './constants';

const ALLOWED_FENCED_EVENTS = new Set<AgentEvent['kind']>([
  'finished',
  'session-end',
  'context-usage',
  'token-usage',
]);

function payload(event: AgentEvent): Record<string, unknown> {
  return event.payload && typeof event.payload === 'object'
    ? (event.payload as Record<string, unknown>)
    : {};
}

function isSuccessfulToolResult(event: AgentEvent): boolean {
  const value = payload(event);
  const status =
    typeof value.status === 'string' ? value.status.toLowerCase() : '';
  return (
    (value.error == null || value.error === false) &&
    !['failed', 'error', 'denied', 'cancelled', 'canceled'].includes(status)
  );
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function samePath(left: string | null, right: string): boolean {
  return left !== null && resolve(left) === resolve(right);
}

/**
 * Owns provider observation, expected interruption, runtime/DB compensation and delivery order.
 * All asynchronous work starts from a microtask so the normalized tool/terminal event is first
 * durably ingested by the current adapter sink.
 */
export class WorktreeTransitionCoordinator {
  private readonly finalizing = new Map<string, Promise<void>>();

  reserveToolInvocation(
    sessionId: string,
    direction: WorktreeTransitionDirection,
  ): string {
    return worktreeToolInvocationRegistry.reserve(sessionId, direction);
  }

  bindToolInvocation(
    sessionId: string,
    toolUseId: string,
    generation: number,
  ): void {
    worktreeToolInvocationRegistry.bindGeneration(
      sessionId,
      toolUseId,
      generation,
    );
  }

  releaseToolInvocation(
    sessionId: string,
    toolUseId: string,
    generation?: number,
  ): void {
    worktreeToolInvocationRegistry.release(
      sessionId,
      toolUseId,
      generation,
    );
  }

  arm(record: WorktreeTransitionRecord): void {
    const adapter = this.requireAdapter(record.sessionId);
    if (
      !adapter.armCwdTransition ||
      !adapter.switchCwdForTransition ||
      !adapter.releaseCwdTransition ||
      !adapter.getRuntimeCwd ||
      !adapter.interruptSession
    ) {
      throw new Error(
        `${adapter.id} does not implement automatic worktree cwd transitions.`,
      );
    }
    adapter.armCwdTransition(toAgentCwdTransition(record));
  }

  /** Restore user inputs accepted while a preparation record existed but no cwd switch was armed. */
  async releaseAbortedPreparation(
    record: WorktreeTransitionRecord,
  ): Promise<void> {
    const adapter = this.requireAdapter(record.sessionId);
    await replayAbortedTransitionInputs(record, adapter);
    adapter.releaseCwdTransition?.(record.sessionId, record.generation);
    if (record.toolUseId) {
      this.releaseToolInvocation(
        record.sessionId,
        record.toolUseId,
        record.generation,
      );
    }
  }

  /**
   * Returns false when an acknowledged old-turn event must be dropped. Tool-result and terminal
   * accounting are always retained.
   */
  observe(event: AgentEvent): boolean {
    worktreeToolInvocationRegistry.observe(event);
    if (event.source !== 'sdk') return true;
    const record = worktreeTransitionRepo.get(event.sessionId);
    if (!record || record.phase === 'active' || record.phase === 'cleared') {
      return true;
    }

    const value = payload(event);
    const toolUseId =
      typeof value.toolUseId === 'string' ? value.toolUseId : null;
    const isMatchingToolResult =
      event.kind === 'tool-use-end' &&
      toolUseId !== null &&
      toolUseId === record.toolUseId;
    if (isMatchingToolResult) {
      if (!isSuccessfulToolResult(event)) {
        const failure =
          'Provider reported the transition MCP tool result as failed; no interrupt was issued.';
        worktreeTransitionRepo.setLastError(
          record.sessionId,
          record.generation,
          failure,
          Date.now(),
        );
        queueMicrotask(() => {
          void recoverWorktreeTransition(record.sessionId).catch((error) => {
            emitWorktreeTransitionStatus(
              record.sessionId,
              `⚠ 工作目录切换撤销未完成：${errorText(error)}`,
              true,
              record.generation,
            );
          });
        });
        return true;
      }
      const expected =
        record.direction === 'enter'
          ? 'enter_waiting_tool_result'
          : 'exit_waiting_tool_result';
      const next =
        record.direction === 'enter'
          ? 'interrupting_enter_turn'
          : 'interrupting_exit_turn';
      if (record.phase === expected) {
        try {
          worktreeTransitionRepo.compareAndSetPhase({
            sessionId: record.sessionId,
            generation: record.generation,
            expected,
            next,
            updatedAt: Date.now(),
          });
          queueMicrotask(() => {
            void this.requestExpectedInterrupt(record.sessionId, record.generation);
          });
        } catch (error) {
          if (!(error instanceof WorktreeTransitionConflictError)) throw error;
        }
      }
      return true;
    }

    if (
      record.phase === 'interrupting_enter_turn' ||
      record.phase === 'interrupting_exit_turn'
    ) {
      if (event.kind === 'finished') {
        event.payload = {
          ...value,
          expectedWorktreeTransition: {
            generation: record.generation,
            direction: record.direction,
          },
        };
        queueMicrotask(() => {
          void this.finalize(record.sessionId, record.generation);
        });
        return true;
      }
      return ALLOWED_FENCED_EVENTS.has(event.kind);
    }
    return true;
  }

  private async requestExpectedInterrupt(
    sessionId: string,
    generation: number,
  ): Promise<void> {
    const record = worktreeTransitionRepo.get(sessionId);
    if (
      !record ||
      record.generation !== generation ||
      !(
        record.phase === 'interrupting_enter_turn' ||
        record.phase === 'interrupting_exit_turn'
      )
    ) {
      return;
    }
    const adapter = this.requireAdapter(sessionId);
    try {
      await adapter.interruptSession?.(sessionId);
    } catch (error) {
      worktreeTransitionRepo.setLastError(
        sessionId,
        generation,
        `Expected provider interrupt failed: ${errorText(error)}`,
        Date.now(),
      );
    }
  }

  private finalize(sessionId: string, generation: number): Promise<void> {
    const key = `${sessionId}:${generation}`;
    const existing = this.finalizing.get(key);
    if (existing) return existing;
    const operation = this.finalizeExclusive(sessionId, generation)
      .catch((error) => {
        try {
          worktreeTransitionRepo.setLastError(
            sessionId,
            generation,
            errorText(error),
            Date.now(),
          );
        } catch {
          // A concurrent reconciliation may already have settled or renamed the record.
        }
        emitWorktreeTransitionStatus(
          sessionId,
          `⚠ 工作目录自动切换未完成：${errorText(error)}`,
          true,
          generation,
        );
      })
      .finally(() => {
        if (this.finalizing.get(key) === operation) {
          this.finalizing.delete(key);
        }
      });
    this.finalizing.set(key, operation);
    return operation;
  }

  private async finalizeExclusive(
    sessionId: string,
    generation: number,
  ): Promise<void> {
    const record = worktreeTransitionRepo.get(sessionId);
    if (!record || record.generation !== generation) return;
    if (record.phase === 'interrupting_enter_turn') {
      await this.finalizeEnter(record);
      return;
    }
    if (record.phase === 'interrupting_exit_turn') {
      await this.finalizeExit(record);
    }
  }

  private async finalizeEnter(
    initial: WorktreeTransitionRecord,
  ): Promise<void> {
    let record = worktreeTransitionRepo.compareAndSetPhase({
      sessionId: initial.sessionId,
      generation: initial.generation,
      expected: 'interrupting_enter_turn',
      next: 'switching_to_worktree',
      updatedAt: Date.now(),
    });
    const adapter = this.requireAdapter(record.sessionId);
    const transition = toAgentCwdTransition(record);
    let switched = false;
    let persisted = false;
    try {
      const result = await adapter.switchCwdForTransition!(transition);
      switched = true;
      sessionRepo.setCwd(record.sessionId, record.targetCwd);
      persisted = true;
      emitWorktreeSessionUpsert(record.sessionId);
      await deliverTransitionWork(
        record,
        adapter,
        transition,
        result.continuationAccepted,
      );
      record = worktreeTransitionRepo.compareAndSetPhase({
        sessionId: record.sessionId,
        generation: record.generation,
        expected: 'switching_to_worktree',
        next: 'active',
        updatedAt: Date.now(),
      });
      emitWorktreeTransitionStatus(
        record.sessionId,
        '已切换到 worktree，正在继续当前任务',
        false,
        record.generation,
      );
      this.releaseAdapter(adapter, record);
      this.releaseToolInvocation(
        record.sessionId,
        record.toolUseId!,
        record.generation,
      );
    } catch (error) {
      if (switched && !persisted) {
        await compensateTransitionRuntime(adapter, transition);
      }
      const current = worktreeTransitionRepo.get(initial.sessionId);
      if (!current || current.generation !== initial.generation) throw error;
      if (current.phase === 'active' || current.phase === 'cleared') return;
      const runtimeCwd = adapter.getRuntimeCwd?.(current.sessionId) ?? null;
      if (samePath(runtimeCwd, current.worktreePath)) {
        await completeAcknowledgedEnter(current);
        return;
      }
      if (samePath(runtimeCwd, current.originalCwd)) {
        await abortFailedEnterAtOriginalCwd(current, errorText(error));
        return;
      }
      throw error;
    }
  }

  private async finalizeExit(
    initial: WorktreeTransitionRecord,
  ): Promise<void> {
    let record = worktreeTransitionRepo.compareAndSetPhase({
      sessionId: initial.sessionId,
      generation: initial.generation,
      expected: 'interrupting_exit_turn',
      next: 'restoring_original_cwd',
      updatedAt: Date.now(),
    });
    const adapter = this.requireAdapter(record.sessionId);
    const transition = toAgentCwdTransition(record);
    let switched = false;
    let persisted = false;
    try {
      const result = await adapter.switchCwdForTransition!(transition);
      switched = true;
      sessionRepo.setCwd(record.sessionId, record.originalCwd);
      persisted = true;
      emitWorktreeSessionUpsert(record.sessionId);
      record = worktreeTransitionRepo.compareAndSetPhase({
        sessionId: record.sessionId,
        generation: record.generation,
        expected: 'restoring_original_cwd',
        next: 'cleanup_pending',
        updatedAt: Date.now(),
      });

      let cleanupError: unknown;
      let branchError: string | null = null;
      try {
        const cleanup = await cleanupStructuredWorktree(record);
        branchError = cleanup.branchError;
      } catch (error) {
        cleanupError = error;
      }
      await deliverTransitionWork(
        record,
        adapter,
        transition,
        result.continuationAccepted,
      );
      if (cleanupError) {
        worktreeTransitionRepo.setLastError(
          record.sessionId,
          record.generation,
          `Worktree cleanup pending: ${errorText(cleanupError)}`,
          Date.now(),
        );
        emitWorktreeTransitionStatus(
          record.sessionId,
          `已恢复原工作目录；worktree 清理待重试：${errorText(cleanupError)}`,
          true,
          record.generation,
        );
        this.releaseAdapter(adapter, record);
        return;
      }
      record = worktreeTransitionRepo.compareAndSetPhase({
        sessionId: record.sessionId,
        generation: record.generation,
        expected: 'cleanup_pending',
        next: 'cleared',
        updatedAt: Date.now(),
        lastError: branchError
          ? `Worktree removed, but branch deletion failed: ${branchError}`
          : null,
      });
      emitWorktreeSessionUpsert(record.sessionId);
      emitWorktreeTransitionStatus(
        record.sessionId,
        branchError
          ? `已恢复原工作目录并移除 worktree；分支保留：${branchError}`
          : '已恢复原工作目录并安全移除 worktree，正在继续当前任务',
        branchError !== null,
        record.generation,
      );
      this.releaseAdapter(adapter, record);
      if (record.toolUseId) {
        this.releaseToolInvocation(
          record.sessionId,
          record.toolUseId,
          record.generation,
        );
      }
    } catch (error) {
      if (switched && !persisted) {
        await compensateTransitionRuntime(adapter, transition);
      }
      const current = worktreeTransitionRepo.get(initial.sessionId);
      if (!current || current.generation !== initial.generation) throw error;
      if (current.phase === 'active' || current.phase === 'cleared') return;
      const runtimeCwd = adapter.getRuntimeCwd?.(current.sessionId) ?? null;
      if (samePath(runtimeCwd, current.originalCwd)) {
        await completeAcknowledgedExit(current);
        return;
      }
      if (samePath(runtimeCwd, current.worktreePath)) {
        await restoreFailedExitAtWorktree(current, errorText(error));
        return;
      }
      throw error;
    }
  }

  private requireAdapter(sessionId: string): AgentAdapter {
    const record = sessionRepo.get(sessionId);
    const agentId = record?.agentId as SessionAdapterId | null | undefined;
    const adapter = agentId ? adapterRegistry.get(agentId) : undefined;
    if (!record || !adapter) {
      throw new Error(
        `Cannot resolve a live adapter for worktree transition session ${sessionId}.`,
      );
    }
    return adapter;
  }

  private releaseAdapter(adapter: AgentAdapter, record: WorktreeTransitionRecord): void {
    adapter.releaseCwdTransition?.(record.sessionId, record.generation);
  }
}

export const worktreeTransitionCoordinator =
  new WorktreeTransitionCoordinator();
