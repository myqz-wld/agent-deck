/**
 * Codex sandbox switch controller.
 *
 * Each `turn/start` carries the current sandbox policy. Switching persists the new per-session
 * value and patches live thread options for the next turn without aborting current work.
 */
import type { AgentEvent, CodexApprovalPolicy } from '@shared/types';
import { AGENT_ID } from './constants';
import { safeDiagnostic, safeErrorSummary } from '@main/utils/safe-diagnostic';
import { mergeCodexWritableRoots } from './thread-options-builder';
import type { CodexBridgeRuntimeHost } from './runtime-host-core';

export type CodexSandboxMode = 'workspace-write' | 'read-only' | 'danger-full-access';

export interface RestartCtx {
  /**
   * Shared single-flight map with recoverer/restart paths. A sandbox change is cheap now, but
   * serializing it with recovery avoids DB/live-option interleaving for the same session.
   */
  recovering: Map<string, Promise<unknown>>;
  emit: (event: AgentEvent) => void;
  runtimeHost: CodexBridgeRuntimeHost;
  /**
   * Patches an in-memory Codex app-server thread when one is live. Returns false for dormant
   * sessions; those pick up the persisted value on their next recovery/createSession path.
   */
  applyLiveSandbox: (
    sessionId: string,
    sandbox: CodexSandboxMode,
    opts: {
      networkAccessEnabled?: boolean;
      additionalDirectories?: readonly string[];
    },
  ) => boolean;
  /** Same next-turn projection as applyLiveSandbox, for Codex approval policy. */
  applyLiveApprovalPolicy: (
    sessionId: string,
    policy: CodexApprovalPolicy | null,
  ) => boolean;
}

export class RestartController {
  constructor(private ctx: RestartCtx) {}

  /**
   * - persist `sessions.codex_sandbox`;
   * - emit `session-upserted` so the UI reflects the selection immediately;
   * - patch live thread options if this session is in memory;
   * - do not close/recreate the app-server thread and do not send a synthetic prompt.
   */
  async setCodexSandbox(
    sessionId: string,
    sandbox: CodexSandboxMode,
  ): Promise<void> {
    let inflight = this.ctx.recovering.get(sessionId);
    while (inflight) {
      try {
        await inflight;
      } catch {
        // A failed previous recovery/switch should not prevent the user's newer selection.
      }
      inflight = this.ctx.recovering.get(sessionId);
    }

    const rec = this.ctx.runtimeHost.records.get(sessionId);
    if (!rec) throw new Error(`session ${sessionId} not found in repo`);
    const oldSandbox: CodexSandboxMode | null = rec.codexSandbox ?? null;

    const p = (async (): Promise<void> => {
      let liveApplyAttempted = false;
      try {
        this.ctx.runtimeHost.records.setCodexSandbox(sessionId, sandbox);
        this.ctx.runtimeHost.records.publishUpdated(sessionId);

        liveApplyAttempted = true;
        const liveApplied = this.ctx.applyLiveSandbox(sessionId, sandbox, {
          networkAccessEnabled: rec.networkAccessEnabled ?? undefined,
          additionalDirectories: mergeCodexWritableRoots(
            rec.additionalDirectories ?? undefined,
            rec.extraAllowWrite ?? undefined,
          ),
        });
        if (!liveApplied) {
          this.ctx.runtimeHost.logger('codex-restart').info(
            `[codex-bridge] persisted sandbox ${sandbox} for dormant session ${sessionId}; ` +
              'next recovery/createSession will apply it',
          );
        }
      } catch (err) {
        let dbRollback: RollbackProjectionOutcome = 'failed';
        let liveRollback: RollbackProjectionOutcome = liveApplyAttempted
          ? 'failed'
          : 'unchanged';
        try {
          this.ctx.runtimeHost.records.setCodexSandbox(sessionId, oldSandbox);
          dbRollback = 'restored';
          this.ctx.runtimeHost.records.publishUpdated(sessionId);
        } catch (rollbackErr) {
          this.ctx.runtimeHost.logger('codex-restart').warn(
            '[codex-bridge] sandbox DB rollback failed; original error is preserved',
            rollbackFailureDiagnostic('sandbox', 'database', sessionId, rollbackErr),
          );
        }
        if (liveApplyAttempted && oldSandbox !== null) {
          try {
            this.ctx.applyLiveSandbox(sessionId, oldSandbox, {
              networkAccessEnabled: rec.networkAccessEnabled ?? undefined,
              additionalDirectories: mergeCodexWritableRoots(
                rec.additionalDirectories ?? undefined,
                rec.extraAllowWrite ?? undefined,
              ),
            });
            liveRollback = 'restored';
          } catch (liveRollbackErr) {
            this.ctx.runtimeHost.logger('codex-restart').warn(
              '[codex-bridge] live sandbox rollback failed',
              rollbackFailureDiagnostic('sandbox', 'live', sessionId, liveRollbackErr),
            );
          }
        } else if (liveApplyAttempted) {
          liveRollback = 'unknown';
        }
        const rollbackComplete =
          dbRollback === 'restored' &&
          (liveRollback === 'restored' || liveRollback === 'unchanged');
        logRollbackOutcome(
          this.ctx.runtimeHost,
          'sandbox',
          sessionId,
          dbRollback,
          liveRollback,
          rollbackComplete,
        );
        this.ctx.emit({
          sessionId,
          agentId: AGENT_ID,
          kind: 'message',
          payload: {
            text: rollbackComplete
              ? `⚠ 切到 sandbox ${sandbox} 失败：${errorText(err)}。` +
                `档位已回退到 ${oldSandbox ?? '(默认)'}。`
              : `⚠ 切到 sandbox ${sandbox} 失败：${errorText(err)}。` +
                `回退未完全成功（数据库：${rollbackOutcomeText(dbRollback)}；` +
                `实时运行时：${rollbackOutcomeText(liveRollback)}），当前状态未知；` +
                '请关闭并重新打开会话后重试。',
            error: true,
          },
          ts: Date.now(),
          source: 'sdk',
        });
        throw err;
      }
    })();

    this.ctx.recovering.set(sessionId, p);
    try {
      return await p;
    } finally {
      this.ctx.recovering.delete(sessionId);
    }
  }

  /**
   * Persist and apply the Codex approval policy used by subsequent `turn/start` requests.
   * The active turn is left alone; dormant sessions consume the persisted choice on recovery.
   */
  async setCodexApprovalPolicy(
    sessionId: string,
    policy: CodexApprovalPolicy,
  ): Promise<void> {
    let inflight = this.ctx.recovering.get(sessionId);
    while (inflight) {
      try {
        await inflight;
      } catch {
        // A failed previous recovery/switch should not prevent the user's newer selection.
      }
      inflight = this.ctx.recovering.get(sessionId);
    }

    const rec = this.ctx.runtimeHost.records.get(sessionId);
    if (!rec) throw new Error(`session ${sessionId} not found in repo`);
    const oldPolicy: CodexApprovalPolicy | null =
      rec.codexApprovalPolicy ?? null;

    const operation = (async (): Promise<void> => {
      let liveApplyAttempted = false;
      try {
        this.ctx.runtimeHost.records.setCodexApprovalPolicy(sessionId, policy);
        this.ctx.runtimeHost.records.publishUpdated(sessionId);

        liveApplyAttempted = true;
        const liveApplied = this.ctx.applyLiveApprovalPolicy(sessionId, policy);
        if (!liveApplied) {
          this.ctx.runtimeHost.logger('codex-restart').info(
            `[codex-bridge] persisted approval policy ${policy} for dormant session ` +
              `${sessionId}; next recovery/createSession will apply it`,
          );
        }
      } catch (error) {
        let dbRollback: RollbackProjectionOutcome = 'failed';
        let liveRollback: RollbackProjectionOutcome = liveApplyAttempted
          ? 'failed'
          : 'unchanged';
        try {
          this.ctx.runtimeHost.records.setCodexApprovalPolicy(sessionId, oldPolicy);
          dbRollback = 'restored';
          this.ctx.runtimeHost.records.publishUpdated(sessionId);
        } catch (rollbackError) {
          this.ctx.runtimeHost.logger('codex-restart').warn(
            '[codex-bridge] approval-policy DB rollback failed; original error is preserved',
            rollbackFailureDiagnostic('approval_policy', 'database', sessionId, rollbackError),
          );
        }
        if (liveApplyAttempted) {
          try {
            this.ctx.applyLiveApprovalPolicy(sessionId, oldPolicy);
            liveRollback = 'restored';
          } catch (liveRollbackError) {
            this.ctx.runtimeHost.logger('codex-restart').warn(
              '[codex-bridge] live approval-policy rollback failed',
              rollbackFailureDiagnostic('approval_policy', 'live', sessionId, liveRollbackError),
            );
          }
        }
        const rollbackComplete =
          dbRollback === 'restored' &&
          (liveRollback === 'restored' || liveRollback === 'unchanged');
        logRollbackOutcome(
          this.ctx.runtimeHost,
          'approval_policy',
          sessionId,
          dbRollback,
          liveRollback,
          rollbackComplete,
        );
        this.ctx.emit({
          sessionId,
          agentId: AGENT_ID,
          kind: 'message',
          payload: {
            text: rollbackComplete
              ? `⚠ 切换审批策略到 ${policy} 失败：${errorText(error)}。` +
                `策略已回退到 ${oldPolicy ?? '(默认)'}。`
              : `⚠ 切换审批策略到 ${policy} 失败：${errorText(error)}。` +
                `回退未完全成功（数据库：${rollbackOutcomeText(dbRollback)}；` +
                `实时运行时：${rollbackOutcomeText(liveRollback)}），当前状态未知；` +
                '请关闭并重新打开会话后重试。',
            error: true,
          },
          ts: Date.now(),
          source: 'sdk',
        });
        throw error;
      }
    })();

    this.ctx.recovering.set(sessionId, operation);
    try {
      await operation;
    } finally {
      this.ctx.recovering.delete(sessionId);
    }
  }
}

type RollbackProjectionOutcome = 'restored' | 'unchanged' | 'failed' | 'unknown';

function logRollbackOutcome(
  runtimeHost: CodexBridgeRuntimeHost,
  control: 'sandbox' | 'approval_policy',
  sessionId: string,
  database: RollbackProjectionOutcome,
  live: RollbackProjectionOutcome,
  complete: boolean,
): void {
  runtimeHost.logger('codex-restart').warn(
    '[codex-bridge] runtime-control rollback outcome',
    safeDiagnostic({
    event: 'codex_runtime_control_rollback',
    phase: 'rollback',
    control,
    sessionShort: sessionId.slice(0, 12),
    database,
    live,
    outcome: complete ? 'restored' : 'state_unknown',
    }),
  );
}

function rollbackFailureDiagnostic(
  control: 'sandbox' | 'approval_policy',
  projection: 'database' | 'live',
  sessionId: string,
  error: unknown,
): ReturnType<typeof safeDiagnostic> {
  return safeDiagnostic({
    event: 'codex_runtime_control_rollback',
    phase: 'rollback',
    control,
    projection,
    sessionShort: sessionId.slice(0, 12),
    outcome: 'failed',
    error: safeErrorSummary(error),
  });
}

function rollbackOutcomeText(outcome: RollbackProjectionOutcome): string {
  switch (outcome) {
    case 'restored': return '已恢复';
    case 'unchanged': return '未变更';
    case 'failed': return '恢复失败';
    case 'unknown': return '状态未知';
  }
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
