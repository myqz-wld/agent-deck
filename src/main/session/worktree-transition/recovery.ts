import { resolve } from 'node:path';
import { adapterRegistry } from '@main/adapters/registry';
import type { AgentAdapter } from '@main/adapters/types';
import { sessionRepo } from '@main/store/session-repo';
import { worktreeTransitionInputRepo } from '@main/store/worktree-transition-input-repo';
import {
  worktreeTransitionRepo,
  WorktreeTransitionConflictError,
} from '@main/store/worktree-transition-repo';
import type {
  SessionAdapterId,
  UploadedAttachmentRef,
} from '@shared/types';
import log from '@main/utils/logger';
import {
  isLegacyExitContinuationKey,
  WORKTREE_TRANSITION_CONTINUATION,
} from './constants';
import {
  cleanupStructuredWorktree,
  rollbackUnacknowledgedEnter,
} from './git-cleanup';
import {
  emitWorktreeSessionUpsert,
  emitWorktreeTransitionStatus,
} from './projection';
import type {
  WorktreeTransitionRecord,
} from './types';

const logger = log.scope('worktree-transition-recovery');
const inFlight = new Map<string, Promise<void>>();

export interface WorktreeTransitionRecoverySummary {
  recovered: number;
  skippedClosed: number;
  failed: number;
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function samePath(left: string, right: string): boolean {
  return resolve(left) === resolve(right);
}

function requireAdapter(record: WorktreeTransitionRecord): AgentAdapter {
  const session = sessionRepo.get(record.sessionId);
  const agentId = session?.agentId as SessionAdapterId | null | undefined;
  const adapter = agentId ? adapterRegistry.get(agentId) : undefined;
  if (!session || !adapter?.enqueueMessage) {
    throw new Error(
      `Cannot recover worktree transition ${record.sessionId}:${record.generation}: adapter is unavailable.`,
    );
  }
  return adapter;
}

function assertRuntimeAtOrCold(
  adapter: AgentAdapter,
  record: WorktreeTransitionRecord,
  expectedCwd: string,
): void {
  const runtimeCwd = adapter.getRuntimeCwd?.(record.sessionId) ?? null;
  if (!runtimeCwd || samePath(runtimeCwd, expectedCwd)) return;
  throw new Error(
    `Runtime cwd ${runtimeCwd} conflicts with recovery target ${expectedCwd}; state retained fail-closed.`,
  );
}

async function enqueueBufferedInputs(
  record: WorktreeTransitionRecord,
  adapter: AgentAdapter,
): Promise<void> {
  for (const input of worktreeTransitionInputRepo.listPending(
    record.sessionId,
    record.generation,
  )) {
    await adapter.enqueueMessage!(
      record.sessionId,
      input.text,
      input.attachments as UploadedAttachmentRef[],
      {
        bypassQueueLimit: true,
        userEventAlreadyPersisted: true,
        bypassWorktreeTransitionGuard: true,
        idempotencyKey: `${record.continuationKey}:input:${input.sequence}`,
      },
    );
    worktreeTransitionInputRepo.markDelivered(
      record.sessionId,
      record.generation,
      input.sequence,
      Date.now(),
    );
  }
}

async function enqueueContinuationAndInputs(
  record: WorktreeTransitionRecord,
  adapter: AgentAdapter,
): Promise<void> {
  if (!record.continuationDelivered) {
    await adapter.enqueueMessage!(
      record.sessionId,
      WORKTREE_TRANSITION_CONTINUATION,
      undefined,
      {
        bypassQueueLimit: true,
        userEventAlreadyPersisted: true,
        bypassWorktreeTransitionGuard: true,
        idempotencyKey: record.continuationKey,
      },
    );
    worktreeTransitionRepo.markContinuationDelivered(
      record.sessionId,
      record.generation,
      record.continuationKey,
      Date.now(),
    );
  }
  await enqueueBufferedInputs(record, adapter);
}

async function rollbackEnterAtOriginalCwd(
  record: WorktreeTransitionRecord,
  statusText: string,
  failure: string | null = null,
): Promise<void> {
  const adapter = requireAdapter(record);
  assertRuntimeAtOrCold(adapter, record, record.originalCwd);
  sessionRepo.setCwd(record.sessionId, record.originalCwd);
  emitWorktreeSessionUpsert(record.sessionId);
  await rollbackUnacknowledgedEnter(record);
  await enqueueBufferedInputs(record, adapter);
  const current = worktreeTransitionRepo.get(record.sessionId);
  if (
    current &&
    current.generation === record.generation &&
    (current.phase === 'creating' ||
      current.phase === 'enter_waiting_tool_result' ||
      current.phase === 'interrupting_enter_turn' ||
      current.phase === 'switching_to_worktree')
  ) {
    worktreeTransitionRepo.compareAndSetPhase({
      sessionId: record.sessionId,
      generation: record.generation,
      expected: current.phase,
      next: 'cleared',
      updatedAt: Date.now(),
      lastError: failure,
    });
  }
  adapter.releaseCwdTransition?.(record.sessionId, record.generation);
  emitWorktreeSessionUpsert(record.sessionId);
  emitWorktreeTransitionStatus(
    record.sessionId,
    statusText,
    failure !== null,
    record.generation,
  );
}

export async function completeAcknowledgedEnter(
  initial: WorktreeTransitionRecord,
): Promise<void> {
  const adapter = requireAdapter(initial);
  assertRuntimeAtOrCold(adapter, initial, initial.worktreePath);
  sessionRepo.setCwd(initial.sessionId, initial.worktreePath);
  sessionRepo.setCwdReleaseMarker(initial.sessionId, initial.worktreePath);
  emitWorktreeSessionUpsert(initial.sessionId);
  let record = worktreeTransitionRepo.get(initial.sessionId);
  if (!record || record.generation !== initial.generation) return;
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
  await enqueueContinuationAndInputs(record, adapter);
  record = worktreeTransitionRepo.compareAndSetPhase({
    sessionId: record.sessionId,
    generation: record.generation,
    expected: 'switching_to_worktree',
    next: 'active',
    updatedAt: Date.now(),
  });
  adapter.releaseCwdTransition?.(record.sessionId, record.generation);
  emitWorktreeSessionUpsert(record.sessionId);
  emitWorktreeTransitionStatus(
    record.sessionId,
    '应用重启后已恢复 worktree 工作目录，正在继续当前任务',
    false,
    record.generation,
  );
}

async function restoreExitAtWorktree(
  record: WorktreeTransitionRecord,
  statusText: string,
  failure: string,
): Promise<void> {
  const adapter = requireAdapter(record);
  assertRuntimeAtOrCold(adapter, record, record.worktreePath);
  sessionRepo.setCwd(record.sessionId, record.worktreePath);
  sessionRepo.setCwdReleaseMarker(record.sessionId, record.worktreePath);
  emitWorktreeSessionUpsert(record.sessionId);
  await enqueueBufferedInputs(record, adapter);
  const latest = worktreeTransitionRepo.get(record.sessionId);
  if (
    latest &&
    latest.generation === record.generation &&
    (latest.phase === 'exit_preflight' ||
      latest.phase === 'exit_waiting_tool_result' ||
      latest.phase === 'interrupting_exit_turn' ||
      latest.phase === 'restoring_original_cwd')
  ) {
    worktreeTransitionRepo.compareAndSetPhase({
      sessionId: latest.sessionId,
      generation: latest.generation,
      expected: latest.phase,
      next: 'active',
      updatedAt: Date.now(),
      lastError: failure,
    });
  }
  adapter.releaseCwdTransition?.(record.sessionId, record.generation);
  emitWorktreeSessionUpsert(record.sessionId);
  emitWorktreeTransitionStatus(
    record.sessionId,
    statusText,
    true,
    record.generation,
  );
}

async function releaseUnacknowledgedLegacyExit(
  record: WorktreeTransitionRecord,
): Promise<void> {
  if (
    record.phase !== 'exit_preflight' &&
    record.phase !== 'exit_waiting_tool_result'
  ) {
    throw new Error(
      `Cannot release acknowledged legacy exit ${record.sessionId}:${record.generation} from ${record.phase}.`,
    );
  }
  const adapter = requireAdapter(record);
  await enqueueBufferedInputs(record, adapter);
  worktreeTransitionRepo.releaseLegacyExitAdoption({
    sessionId: record.sessionId,
    generation: record.generation,
    expected: record.phase,
    updatedAt: Date.now(),
    lastError:
      'Legacy exit tool result was not observed before restart; the marker and worktree were retained.',
  });
  adapter.releaseCwdTransition?.(record.sessionId, record.generation);
  emitWorktreeSessionUpsert(record.sessionId);
  emitWorktreeTransitionStatus(
    record.sessionId,
    '未确认的旧版 worktree 退出已取消，worktree 与清理标记均已保留',
    true,
    record.generation,
  );
}

export async function completeAcknowledgedExit(
  initial: WorktreeTransitionRecord,
): Promise<void> {
  const adapter = requireAdapter(initial);
  assertRuntimeAtOrCold(adapter, initial, initial.originalCwd);
  sessionRepo.setCwd(initial.sessionId, initial.originalCwd);
  emitWorktreeSessionUpsert(initial.sessionId);
  let record = worktreeTransitionRepo.get(initial.sessionId);
  if (!record || record.generation !== initial.generation) return;
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

  let cleanupError: unknown;
  try {
    await cleanupStructuredWorktree(record);
  } catch (error) {
    cleanupError = error;
  }
  await enqueueContinuationAndInputs(record, adapter);
  if (cleanupError) {
    worktreeTransitionRepo.setLastError(
      record.sessionId,
      record.generation,
      `Worktree cleanup pending after restart: ${errorText(cleanupError)}`,
      Date.now(),
    );
    adapter.releaseCwdTransition?.(record.sessionId, record.generation);
    emitWorktreeTransitionStatus(
      record.sessionId,
      `已恢复原工作目录；worktree 清理待重试：${errorText(cleanupError)}`,
      true,
      record.generation,
    );
    return;
  }
  record = worktreeTransitionRepo.compareAndSetPhase({
    sessionId: record.sessionId,
    generation: record.generation,
    expected: 'cleanup_pending',
    next: 'cleared',
    updatedAt: Date.now(),
    lastError: null,
  });
  adapter.releaseCwdTransition?.(record.sessionId, record.generation);
  emitWorktreeSessionUpsert(record.sessionId);
  emitWorktreeTransitionStatus(
    record.sessionId,
    '应用重启后已恢复原工作目录并安全移除 worktree',
    false,
    record.generation,
  );
}

function reconcileActiveLease(record: WorktreeTransitionRecord): void {
  const adapter = requireAdapter(record);
  assertRuntimeAtOrCold(adapter, record, record.worktreePath);
  sessionRepo.setCwd(record.sessionId, record.worktreePath);
  sessionRepo.setCwdReleaseMarker(record.sessionId, record.worktreePath);
  emitWorktreeSessionUpsert(record.sessionId);
}

async function reconcileRecord(record: WorktreeTransitionRecord): Promise<void> {
  switch (record.phase) {
    case 'creating':
    case 'enter_waiting_tool_result':
      await rollbackEnterAtOriginalCwd(
        record,
        '未确认的 worktree 切换已安全取消，仍在原工作目录',
      );
      return;
    case 'interrupting_enter_turn':
    case 'switching_to_worktree':
      await completeAcknowledgedEnter(record);
      return;
    case 'active':
      reconcileActiveLease(record);
      return;
    case 'exit_preflight':
    case 'exit_waiting_tool_result':
      if (isLegacyExitContinuationKey(record.continuationKey)) {
        await releaseUnacknowledgedLegacyExit(record);
        return;
      }
      await restoreExitAtWorktree(
        record,
        '未确认的 worktree 退出已取消，仍在 worktree 工作目录',
        'Exit tool result was not observed before restart; the active worktree lease was retained.',
      );
      return;
    case 'interrupting_exit_turn':
    case 'restoring_original_cwd':
    case 'cleanup_pending':
      await completeAcknowledgedExit(record);
      return;
    case 'cleared':
      return;
  }
}

export async function abortFailedEnterAtOriginalCwd(
  record: WorktreeTransitionRecord,
  failure: string,
): Promise<void> {
  await rollbackEnterAtOriginalCwd(
    record,
    'worktree 切换失败，已安全恢复原工作目录',
    failure,
  );
}

export async function restoreFailedExitAtWorktree(
  record: WorktreeTransitionRecord,
  failure: string,
): Promise<void> {
  await restoreExitAtWorktree(
    record,
    'worktree 退出失败，已保留 worktree 工作目录',
    failure,
  );
}

export function recoverWorktreeTransition(
  sessionId: string,
): Promise<void> {
  const existing = inFlight.get(sessionId);
  if (existing) return existing;
  const operation = (async () => {
    const record = worktreeTransitionRepo.get(sessionId);
    if (!record || record.phase === 'cleared') return;
    try {
      await reconcileRecord(record);
    } catch (error) {
      if (!(error instanceof WorktreeTransitionConflictError)) {
        try {
          worktreeTransitionRepo.setLastError(
            record.sessionId,
            record.generation,
            `Recovery failed: ${errorText(error)}`,
            Date.now(),
          );
        } catch {
          // Another legal owner may have settled or renamed the generation.
        }
        emitWorktreeTransitionStatus(
          record.sessionId,
          `⚠ 工作目录恢复未完成：${errorText(error)}`,
          true,
          record.generation,
        );
      }
      throw error;
    }
  })().finally(() => {
    if (inFlight.get(sessionId) === operation) inFlight.delete(sessionId);
  });
  inFlight.set(sessionId, operation);
  return operation;
}

export async function reconcileWorktreeTransitionsAtStartup(): Promise<WorktreeTransitionRecoverySummary> {
  const summary: WorktreeTransitionRecoverySummary = {
    recovered: 0,
    skippedClosed: 0,
    failed: 0,
  };
  for (const transition of worktreeTransitionRepo.listRecoverable()) {
    const session = sessionRepo.get(transition.sessionId);
    if (
      !session ||
      session.lifecycle === 'closed' ||
      session.archivedAt !== null
    ) {
      summary.skippedClosed += 1;
      continue;
    }
    try {
      await recoverWorktreeTransition(transition.sessionId);
      summary.recovered += 1;
    } catch (error) {
      summary.failed += 1;
      logger.warn(
        `startup recovery retained ${transition.sessionId}:${transition.generation} fail-closed`,
        error,
      );
    }
  }
  return summary;
}
