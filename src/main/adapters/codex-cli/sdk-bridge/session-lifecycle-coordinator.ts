import type { ForkSessionSource } from '../../types/fork-session';
import type { CodexAppServerClient } from '../app-server/client';
import log from '@main/utils/logger';
import type { InternalSession } from './types';
import {
  armCodexSessionRetirement,
  finalizeCodexSessionRetirement,
  finalizeCodexSessionRetirementForRollback,
  type CodexSessionRetirementContext,
} from './session-retirement';

const logger = log.scope('codex-bridge');

export class CodexSessionLifecycleCoordinator {
  constructor(
    private readonly sessions: Map<string, InternalSession>,
    private readonly clients: Map<string, CodexAppServerClient>,
    private readonly cancelPermission: (internal: InternalSession) => void,
    private readonly retirementContext: CodexSessionRetirementContext,
  ) {}

  validateForkSource(source: ForkSessionSource): void {
    const sourceClient = this.clients.get(source.applicationSessionId);
    const sourceInternal = this.sessions.get(source.applicationSessionId);
    if (
      !sourceClient ||
      !sourceClient.isProcessAlive ||
      !sourceInternal ||
      sourceInternal.threadId !== source.nativeSessionId
    ) {
      throw new Error(
        'Codex native fork requires caller-owned live app-server state matching the caller native thread. Retry while the caller turn is active or use contextMode "fresh".',
      );
    }
  }

  retireAfterCurrentTurn(sessionId: string): void {
    const internal = this.sessions.get(sessionId);
    if (!internal) return;
    armCodexSessionRetirement(internal);
    if (!internal.currentTurn && !internal.turnLoopRunning) this.finalizeOrdinary(internal);
  }

  async closeOrdinary(sessionId: string): Promise<void> {
    const internal = this.findSession(sessionId);
    if (!internal) return;
    internal.intentionallyClosed = true;
    armCodexSessionRetirement(internal, true);
    this.cancelPermission(internal);
    if (internal.currentTurn) {
      try {
        internal.currentTurn.abort();
      } catch (error) {
        logger.warn(`[codex-bridge] abort during close failed: ${sessionId}`, error);
      }
      internal.currentTurn = null;
      internal.currentTurnId = null;
    }
    this.finalizeOrdinary(internal);
  }

  async closeForRollback(sessionId: string): Promise<void> {
    const internal = this.findSession(sessionId);
    if (!internal) {
      throw new Error(`Codex rollback close cannot prove a live target runtime for ${sessionId}`);
    }
    internal.intentionallyClosed = true;
    armCodexSessionRetirement(internal, true);
    this.cancelPermission(internal);
    if (internal.currentTurn) {
      try {
        internal.currentTurn.abort();
      } catch (error) {
        logger.warn(`[codex-bridge] strict abort during close failed: ${sessionId}`, error);
      }
    }
    finalizeCodexSessionRetirementForRollback(this.retirementContext, internal);
    internal.currentTurn = null;
    internal.currentTurnId = null;
  }

  finalizeOrdinary(internal: InternalSession): void {
    this.cancelPermission(internal);
    finalizeCodexSessionRetirement(this.retirementContext, internal);
  }

  private findSession(sessionId: string): InternalSession | null {
    const direct = this.sessions.get(sessionId);
    if (direct) return direct;
    for (const internal of this.sessions.values()) {
      if (internal.applicationSid === sessionId || internal.threadId === sessionId) return internal;
    }
    return null;
  }
}
