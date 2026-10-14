import type { PermissionMode } from '@shared/types';
import {
  codexPermissionPreset,
  requireSessionPermissionMode,
  type SessionPermissionMode,
} from '@shared/permission-modes';
import type { CodexBridgeSessionRecordPort } from './runtime-host-core';

interface PermissionModeContext {
  operations: Map<string, Promise<unknown>>;
  records: CodexBridgeSessionRecordPort;
  applyLive: (sessionId: string, mode: SessionPermissionMode) => (() => void) | void;
}

/** Shares the recovery lock so a restored thread cannot resurrect a superseded permission preset. */
export async function setCodexPermissionMode(
  sessionId: string,
  input: PermissionMode,
  context: PermissionModeContext,
): Promise<void> {
  const mode = requireSessionPermissionMode(input);
  let previousOperation = context.operations.get(sessionId);
  while (previousOperation) {
    await previousOperation.catch(() => undefined);
    previousOperation = context.operations.get(sessionId);
  }
  const operation = (async () => {
    // Claim the shared map before running synchronous projections. Recovery owns its entry until
    // it finishes; replacing that entry early would let its cleanup erase a queued mutation.
    await Promise.resolve();
    const record = context.records.get(sessionId);
    if (!record) throw new Error('会话不存在，无法修改权限模式。');
    const oldMode = record.permissionMode ?? null;
    const oldPolicy = record.codexApprovalPolicy ?? null;
    let restoreLive: (() => void) | void = undefined;
    try {
      context.records.setPermissionMode(sessionId, mode);
      context.records.setCodexApprovalPolicy(sessionId, codexPermissionPreset(mode).approvalPolicy);
      restoreLive = context.applyLive(sessionId, mode);
      context.records.publishUpdated(sessionId);
    } catch (error) {
      const failures: unknown[] = [];
      for (const restore of [
        () => context.records.setPermissionMode(sessionId, oldMode),
        () => context.records.setCodexApprovalPolicy(sessionId, oldPolicy),
        () => restoreLive?.(),
        () => context.records.publishUpdated(sessionId),
      ]) {
        try { restore(); } catch (rollbackError) { failures.push(rollbackError); }
      }
      if (failures.length) {
        throw new AggregateError([error, ...failures], '权限模式切换失败，回退未完全成功；请重新打开会话后检查。');
      }
      throw error;
    }
  })();
  context.operations.set(sessionId, operation);
  try {
    await operation;
  } finally {
    if (context.operations.get(sessionId) === operation) context.operations.delete(sessionId);
  }
}
