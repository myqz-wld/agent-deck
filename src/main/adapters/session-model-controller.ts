import type { AgentEvent } from '@shared/types';
import type { SessionModelOptions } from './session-model-options';
import { sessionRepo } from '@main/store/session-repo';
import { eventBus } from '@main/event-bus';
import log from '@main/utils/logger';

const logger = log.scope('session-model-controller');

export interface SessionModelControllerContext {
  /** Shared with recovery/restart paths so a dormant wake-up cannot race a model change. */
  operations: Map<string, Promise<unknown>>;
  agentId: string;
  emit: (event: AgentEvent) => void;
  /** Returns false when no provider query/thread is currently in memory. */
  applyLive: (
    sessionId: string,
    options: SessionModelOptions,
  ) => Promise<boolean> | boolean;
}

/**
 * Provider-neutral persistence / rollback boundary for next-turn model changes.
 *
 * The source session remains usable on every failure: DB values are restored and, when a live
 * provider update partially succeeded, the old live selection is applied best-effort as well.
 */
export class SessionModelController {
  constructor(private readonly ctx: SessionModelControllerContext) {}

  async setOptions(sessionId: string, options: SessionModelOptions): Promise<void> {
    let inflight = this.ctx.operations.get(sessionId);
    while (inflight) {
      try {
        await inflight;
      } catch {
        // A newer user selection may proceed after a failed recovery/switch.
      }
      inflight = this.ctx.operations.get(sessionId);
    }

    const record = sessionRepo.get(sessionId);
    if (!record) throw new Error(`session ${sessionId} not found`);
    const previous: SessionModelOptions = {
      model: record.model ?? null,
      thinking: record.thinking ?? null,
    };

    const operation = (async () => {
      let liveAttempted = false;
      try {
        sessionRepo.setModel(sessionId, options.model);
        sessionRepo.setThinking(sessionId, options.thinking);
        const updated = sessionRepo.get(sessionId);
        if (updated) eventBus.emit('session-upserted', updated);

        liveAttempted = true;
        const liveApplied = await this.ctx.applyLive(sessionId, options);
        if (!liveApplied) {
          logger.info(
            `[${this.ctx.agentId}] persisted model options for dormant session ${sessionId}; ` +
              'the next recovery will apply them',
          );
        }
      } catch (error) {
        try {
          sessionRepo.setModel(sessionId, previous.model);
          sessionRepo.setThinking(sessionId, previous.thinking);
          const reverted = sessionRepo.get(sessionId);
          if (reverted) eventBus.emit('session-upserted', reverted);
        } catch (rollbackError) {
          logger.warn(`[${this.ctx.agentId}] DB model-option rollback failed for ${sessionId}:`, rollbackError);
        }
        if (liveAttempted) {
          try {
            await this.ctx.applyLive(sessionId, previous);
          } catch (rollbackError) {
            logger.warn(
              `[${this.ctx.agentId}] live model-option rollback failed for ${sessionId}:`,
              rollbackError,
            );
          }
        }
        this.ctx.emit({
          sessionId,
          agentId: this.ctx.agentId,
          kind: 'message',
          payload: {
            text:
              `⚠ 切换模型或思考程度失败：${error instanceof Error ? error.message : String(error)}。` +
              '已恢复原设置。',
            error: true,
          },
          ts: Date.now(),
          source: 'sdk',
        });
        throw error;
      }
    })();

    this.ctx.operations.set(sessionId, operation);
    try {
      await operation;
    } finally {
      if (this.ctx.operations.get(sessionId) === operation) {
        this.ctx.operations.delete(sessionId);
      }
    }
  }
}
