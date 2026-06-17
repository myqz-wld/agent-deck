/**
 * Codex sandbox switch controller.
 *
 * The public method name is kept for IPC/preload compatibility, but app-server Codex no
 * longer needs a cold restart for sandbox changes: each `turn/start` carries the current
 * sandbox policy. Switching now persists the new per-session sandbox and patches the live
 * thread options so the next turn uses it, without aborting the current turn or clearing
 * queued messages.
 */
import type { AgentEvent } from '@shared/types';
import { sessionRepo } from '@main/store/session-repo';
import { eventBus } from '@main/event-bus';
import { AGENT_ID } from './constants';
import log from '@main/utils/logger';

const logger = log.scope('codex-restart');

export type CodexSandboxMode = 'workspace-write' | 'read-only' | 'danger-full-access';

export interface RestartCtx {
  /**
   * Shared single-flight map with recoverer/restart paths. A sandbox change is cheap now, but
   * serializing it with recovery avoids DB/live-option interleaving for the same session.
   */
  recovering: Map<string, Promise<unknown>>;
  emit: (event: AgentEvent) => void;
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
}

export class RestartController {
  constructor(private ctx: RestartCtx) {}

  /**
   * Compatibility wrapper for the old cold-restart API.
   *
   * Current semantics:
   * - persist `sessions.codex_sandbox`;
   * - emit `session-upserted` so the UI reflects the selection immediately;
   * - patch live thread options if this session is in memory;
   * - do not close/recreate the app-server thread and do not send a synthetic prompt.
   */
  async restartWithCodexSandbox(
    sessionId: string,
    sandbox: CodexSandboxMode,
    _handoffPrompt: string,
  ): Promise<string> {
    let inflight = this.ctx.recovering.get(sessionId);
    while (inflight) {
      try {
        await inflight;
      } catch {
        // A failed previous recovery/switch should not prevent the user's newer selection.
      }
      inflight = this.ctx.recovering.get(sessionId);
    }

    const rec = sessionRepo.get(sessionId);
    if (!rec) throw new Error(`session ${sessionId} not found in repo`);
    const oldSandbox: CodexSandboxMode | null = rec.codexSandbox ?? null;

    const p = (async (): Promise<string> => {
      try {
        sessionRepo.setCodexSandbox(sessionId, sandbox);
        const updatedRec = sessionRepo.get(sessionId);
        if (updatedRec) eventBus.emit('session-upserted', updatedRec);

        const liveApplied = this.ctx.applyLiveSandbox(sessionId, sandbox, {
          networkAccessEnabled: rec.networkAccessEnabled ?? undefined,
          additionalDirectories: rec.additionalDirectories ?? undefined,
        });
        if (!liveApplied) {
          logger.info(
            `[codex-bridge] persisted sandbox ${sandbox} for dormant session ${sessionId}; ` +
              'next recovery/createSession will apply it',
          );
        }
        return sessionId;
      } catch (err) {
        try {
          sessionRepo.setCodexSandbox(sessionId, oldSandbox);
          const rolled = sessionRepo.get(sessionId);
          if (rolled) eventBus.emit('session-upserted', rolled);
          if (oldSandbox !== null) {
            try {
              this.ctx.applyLiveSandbox(sessionId, oldSandbox, {
                networkAccessEnabled: rec.networkAccessEnabled ?? undefined,
                additionalDirectories: rec.additionalDirectories ?? undefined,
              });
            } catch (liveRollbackErr) {
              logger.warn(
                `[codex-bridge] live sandbox rollback failed for ${sessionId}; DB rollback still completed:`,
                liveRollbackErr,
              );
            }
          }
        } catch (rollbackErr) {
          logger.warn(
            `[codex-bridge] restartWithCodexSandbox rollback setCodexSandbox(${sessionId}, ${oldSandbox}) failed; original error is preserved:`,
            rollbackErr,
          );
        }
        this.ctx.emit({
          sessionId,
          agentId: AGENT_ID,
          kind: 'message',
          payload: {
            text:
              `⚠ 切到 sandbox ${sandbox} 失败：${(err as Error)?.message ?? String(err)}。` +
              `档位已回退到 ${oldSandbox ?? '(默认)'}。`,
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
}
