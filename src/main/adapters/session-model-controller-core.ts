import type { AgentEvent } from '@shared/types';
import type { SessionModelOptions } from './session-model-options';

export interface SessionModelControllerContext {
  /** Shared with recovery/restart paths so a dormant wake-up cannot race a model change. */
  operations: Map<string, Promise<unknown>>;
  agentId: string;
  emit: (event: AgentEvent) => void;
  /** Validate the requested selection before any persisted or live state is changed. */
  validate?: (
    sessionId: string,
    options: SessionModelOptions,
    previous: SessionModelOptions,
  ) => Promise<void> | void;
  /** Returns false when no provider query/thread is currently in memory. */
  applyLive: (
    sessionId: string,
    options: SessionModelOptions,
    previous: SessionModelOptions,
  ) => Promise<boolean> | boolean;
}

export interface SessionModelControllerRecord {
  runtimeProvider?: string | null;
  model?: string | null;
  thinking?: string | null;
  activity?: string | null;
}

export interface SessionModelControllerHost {
  read(sessionId: string): SessionModelControllerRecord | null;
  setRuntimeProvider(sessionId: string, provider: string | null): void;
  setModel(sessionId: string, model: string | null): void;
  setThinking(sessionId: string, thinking: string | null): void;
  publishUpdated(sessionId: string): void;
  now(): number;
  info(message: string): void;
  warn(message: string, error: unknown): void;
}

/** Persist, apply, and roll back provider/model/thinking selections behind explicit host ports. */
export class SessionModelControllerCore {
  constructor(
    private readonly ctx: SessionModelControllerContext,
    private readonly host: SessionModelControllerHost,
  ) {}

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

    const record = this.host.read(sessionId);
    if (!record) throw new Error(`session ${sessionId} not found`);
    const previous: SessionModelOptions = {
      provider: record.runtimeProvider ?? null,
      model: record.model ?? null,
      thinking: record.thinking ?? null,
    };
    if (
      options.provider !== previous.provider &&
      (record.activity === 'working' || record.activity === 'waiting')
    ) {
      throw new Error('provider cannot be changed while the session is working or waiting');
    }

    const operation = (async () => {
      let persistenceAttempted = false;
      let liveAttempted = false;
      try {
        await this.ctx.validate?.(sessionId, options, previous);
        persistenceAttempted = true;
        this.host.setRuntimeProvider(sessionId, options.provider);
        this.host.setModel(sessionId, options.model);
        this.host.setThinking(sessionId, options.thinking);
        this.host.publishUpdated(sessionId);

        liveAttempted = true;
        const liveApplied = await this.ctx.applyLive(sessionId, options, previous);
        if (!liveApplied) {
          this.host.info(
            `[${this.ctx.agentId}] persisted model options for dormant session ${sessionId}; ` +
              'the next recovery will apply them',
          );
        }
      } catch (error) {
        if (persistenceAttempted) {
          try {
            this.host.setRuntimeProvider(sessionId, previous.provider);
            this.host.setModel(sessionId, previous.model);
            this.host.setThinking(sessionId, previous.thinking);
            this.host.publishUpdated(sessionId);
          } catch (rollbackError) {
            this.host.warn(
              `[${this.ctx.agentId}] DB model-option rollback failed for ${sessionId}:`,
              rollbackError,
            );
          }
        }
        if (liveAttempted) {
          try {
            await this.ctx.applyLive(sessionId, previous, options);
          } catch (rollbackError) {
            this.host.warn(
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
              `⚠ 切换 provider、模型或思考程度失败：${error instanceof Error ? error.message : String(error)}。` +
              (persistenceAttempted ? '已恢复原设置。' : '原设置未变。'),
            error: true,
          },
          ts: this.host.now(),
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
