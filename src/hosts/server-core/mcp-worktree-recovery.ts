import type { AgentAdapter } from '@main/adapters/types';
import { worktreeTransitionRepo } from '@main/store/worktree-transition-repo';
import { isSameWorktreePath, worktreeErrorText } from '@main/session/worktree-transition/coordinator-helpers';
import { WORKTREE_TRANSITION_CONTINUATION } from '@main/session/worktree-transition/constants';
import { settleTransitionInputs } from '@main/session/worktree-transition/transition-delivery';
import type { WorktreeTransitionRecord } from '@main/session/worktree-transition/types';

import type { ServerCoreWorktreeRuntimeDependencies } from './mcp-worktree-runtime-deps';

export interface ServerCoreWorktreeRecoveryOptions
  extends ServerCoreWorktreeRuntimeDependencies {
  readonly releaseInvocation: (
    sessionId: string,
    toolUseId: string,
    generation: number,
  ) => void;
}

/** Reconciles interrupted Core worktree transitions without any Electron-owned registry. */
export class ServerCoreWorktreeRecovery {
  constructor(private readonly options: ServerCoreWorktreeRecoveryOptions) {}

  async recover(sessionId: string, cause?: unknown): Promise<void> {
    let record = worktreeTransitionRepo.get(sessionId);
    if (!record || record.phase === 'cleared') return;
    if (cause !== undefined) {
      try {
        record = worktreeTransitionRepo.setLastError(
          record.sessionId,
          record.generation,
          worktreeErrorText(cause),
          Date.now(),
        );
      } catch {
        return;
      }
    }
    try {
      if (record.phase === 'creating' || record.phase === 'enter_waiting_tool_result') {
        await this.rollbackEnter(record);
      } else if (
        record.phase === 'interrupting_enter_turn' || record.phase === 'switching_to_worktree'
      ) {
        await this.completeEnter(record);
      } else if (record.phase === 'active') {
        this.assertRuntimeAtOrCold(record, record.worktreePath);
        this.setCwd(record.sessionId, record.worktreePath);
      } else if (record.phase === 'exit_preflight' || record.phase === 'exit_waiting_tool_result') {
        await this.restoreExit(record);
      } else {
        await this.completeExit(record);
      }
    } catch (error) {
      try {
        worktreeTransitionRepo.setLastError(
          record.sessionId,
          record.generation,
          `Recovery failed: ${worktreeErrorText(error)}`,
          Date.now(),
        );
      } catch {
        // A legal concurrent owner may already have settled the transition.
      }
      this.options.warn('Server Core worktree recovery retained state fail-closed');
      this.options.publishStatus(
        record.sessionId,
        '工作目录恢复失败，lease 与目录已保留',
        true,
        record.generation,
      );
    }
  }

  private async rollbackEnter(record: WorktreeTransitionRecord): Promise<void> {
    const adapter = this.requireAdapter(record.sessionId);
    this.assertRuntimeAtOrCold(record, record.originalCwd);
    this.setCwd(record.sessionId, record.originalCwd);
    await this.options.cleanup.rollbackEnter(record);
    const current = worktreeTransitionRepo.get(record.sessionId);
    if (!current || current.generation !== record.generation || current.phase === 'cleared') return;
    const toolUseId = current.toolUseId;
    const settled = await settleTransitionInputs(current, adapter, {
      kind: 'phase',
      expected: current.phase,
      next: 'cleared',
      lastError: record.lastError,
    }, 'abort');
    this.releaseOwnership(adapter, settled, toolUseId);
    this.status(settled, '未确认的 worktree 切换已安全取消', Boolean(record.lastError));
  }

  private async completeEnter(initial: WorktreeTransitionRecord): Promise<void> {
    const adapter = this.requireAdapter(initial.sessionId);
    this.assertRuntimeAtOrCold(initial, initial.worktreePath);
    this.setCwd(initial.sessionId, initial.worktreePath);
    let record = worktreeTransitionRepo.get(initial.sessionId)!;
    if (record.phase === 'interrupting_enter_turn') {
      record = worktreeTransitionRepo.compareAndSetPhase({
        sessionId: record.sessionId,
        generation: record.generation,
        expected: 'interrupting_enter_turn',
        next: 'switching_to_worktree',
        updatedAt: Date.now(),
      });
    }
    if (record.phase !== 'switching_to_worktree') return;
    await this.enqueueContinuation(record, adapter);
    const toolUseId = record.toolUseId;
    record = await settleTransitionInputs(record, adapter, {
      kind: 'phase', expected: 'switching_to_worktree', next: 'active',
    }, 'input');
    this.releaseOwnership(adapter, record, toolUseId);
    this.status(record, '已恢复 Workspace 内的 worktree，继续当前任务', false);
  }

  private async restoreExit(record: WorktreeTransitionRecord): Promise<void> {
    const adapter = this.requireAdapter(record.sessionId);
    this.assertRuntimeAtOrCold(record, record.worktreePath);
    this.setCwd(record.sessionId, record.worktreePath);
    const current = worktreeTransitionRepo.get(record.sessionId);
    if (!current || current.generation !== record.generation) return;
    const toolUseId = current.toolUseId;
    const settled = await settleTransitionInputs(current, adapter, {
      kind: 'phase',
      expected: current.phase,
      next: 'active',
      lastError: record.lastError,
    }, 'abort');
    this.releaseOwnership(adapter, settled, toolUseId);
    this.status(settled, '未确认的 worktree 退出已取消，仍在原 worktree', true);
  }

  private async completeExit(initial: WorktreeTransitionRecord): Promise<void> {
    const adapter = this.requireAdapter(initial.sessionId);
    this.assertRuntimeAtOrCold(initial, initial.originalCwd);
    this.setCwd(initial.sessionId, initial.originalCwd);
    let record = worktreeTransitionRepo.get(initial.sessionId)!;
    if (record.phase === 'interrupting_exit_turn') {
      record = worktreeTransitionRepo.compareAndSetPhase({
        sessionId: record.sessionId,
        generation: record.generation,
        expected: 'interrupting_exit_turn',
        next: 'restoring_original_cwd',
        updatedAt: Date.now(),
      });
    }
    if (record.phase === 'restoring_original_cwd') {
      record = worktreeTransitionRepo.compareAndSetPhase({
        sessionId: record.sessionId,
        generation: record.generation,
        expected: 'restoring_original_cwd',
        next: 'cleanup_pending',
        updatedAt: Date.now(),
      });
    }
    if (record.phase !== 'cleanup_pending') return;
    let cleanupFailure: string | null = null;
    try {
      await this.options.cleanup.cleanup(record);
    } catch (error) {
      cleanupFailure = `Worktree cleanup pending after recovery: ${worktreeErrorText(error)}`;
    }
    await this.enqueueContinuation(record, adapter);
    const toolUseId = record.toolUseId;
    record = await settleTransitionInputs(
      record,
      adapter,
      cleanupFailure
        ? { kind: 'seal', expected: 'cleanup_pending', lastError: cleanupFailure }
        : { kind: 'phase', expected: 'cleanup_pending', next: 'cleared' },
      'input',
    );
    this.releaseOwnership(adapter, record, toolUseId);
    this.status(
      record,
      cleanupFailure
        ? '已恢复原目录，worktree 清理待重试'
        : '已恢复原目录并完成 worktree 清理',
      cleanupFailure !== null,
    );
  }

  private async enqueueContinuation(
    record: WorktreeTransitionRecord,
    adapter: AgentAdapter,
  ): Promise<void> {
    if (record.continuationDelivered) return;
    if (!adapter.enqueueMessage) throw new Error('Adapter cannot recover worktree continuation');
    await adapter.enqueueMessage(record.sessionId, WORKTREE_TRANSITION_CONTINUATION, undefined, {
      bypassQueueLimit: true,
      userEventAlreadyPersisted: true,
      bypassWorktreeTransitionGuard: true,
      idempotencyKey: record.continuationKey,
    });
    worktreeTransitionRepo.markContinuationDelivered(
      record.sessionId,
      record.generation,
      record.continuationKey,
      Date.now(),
    );
  }

  private assertRuntimeAtOrCold(record: WorktreeTransitionRecord, expected: string): void {
    const runtimeCwd = this.requireAdapter(record.sessionId).getRuntimeCwd?.(record.sessionId) ?? null;
    if (!runtimeCwd || isSameWorktreePath(runtimeCwd, expected)) return;
    throw new Error('Provider runtime cwd conflicts with the durable worktree lease');
  }

  private requireAdapter(sessionId: string): AgentAdapter {
    const session = this.options.sessions.get(sessionId);
    const adapter = session ? this.options.registry.get(session.agentId) : undefined;
    if (!session || !adapter) throw new Error('Worktree session adapter is unavailable');
    return adapter;
  }

  private setCwd(sessionId: string, cwd: string): void {
    this.options.sessions.setCwd(sessionId, cwd);
    this.options.publishSession(sessionId);
  }

  private releaseOwnership(
    adapter: AgentAdapter,
    record: WorktreeTransitionRecord,
    toolUseId: string | null,
  ): void {
    adapter.releaseCwdTransition?.(record.sessionId, record.generation);
    if (toolUseId) this.options.releaseInvocation(
      record.sessionId,
      toolUseId,
      record.generation,
    );
  }

  private status(record: WorktreeTransitionRecord, text: string, error: boolean): void {
    this.options.publishStatus(record.sessionId, text, error, record.generation);
  }
}
