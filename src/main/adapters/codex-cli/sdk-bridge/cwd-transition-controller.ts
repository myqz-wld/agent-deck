import {
  enqueuePayloadFingerprint,
  isAcceptedEnqueueRetry,
  rememberAcceptedEnqueue,
} from '@main/adapters/enqueue-idempotency';
import type { AgentCwdTransition } from '@main/adapters/types';
import { packCodexInput } from './input-pack';
import type { InternalSession } from './types';

interface CodexCwdTransitionContext {
  sessions: ReadonlyMap<string, InternalSession>;
  runTurnLoop: (session: InternalSession, sessionId: string) => Promise<void>;
}

export class CodexCwdTransitionController {
  constructor(private readonly context: CodexCwdTransitionContext) {}

  arm(transition: AgentCwdTransition): void {
    const session = this.requireSession(transition.sessionId);
    const current = session.cwdTransitionGeneration;
    if (current != null && current !== transition.generation) {
      throw new Error(
        `Codex session ${transition.sessionId} already has cwd transition generation ${current}.`,
      );
    }
    this.requeueSubmittingSteer(session);
    session.cwdTransitionGeneration = transition.generation;
  }

  switchCwd(transition: AgentCwdTransition): void {
    const session = this.requireArmed(transition);
    session.thread.updateWorkingDirectory(transition.targetCwd);
    session.cwd = transition.targetCwd;
  }

  enqueueContinuation(
    transition: AgentCwdTransition,
    text: string,
  ): void {
    const session = this.requireArmed(transition);
    const fingerprint = enqueuePayloadFingerprint(text);
    const accepted = (session.acceptedEnqueueFingerprints ??= new Map());
    if (
      isAcceptedEnqueueRetry(
        accepted,
        transition.continuationKey,
        fingerprint,
      )
    ) {
      return;
    }
    session.pendingMessages.unshift(packCodexInput(text));
    (session.pendingDeferredUserEvents ??= []).unshift(null);
    (session.pendingHandOffMessages ??= []).unshift(null);
    rememberAcceptedEnqueue(
      accepted,
      transition.continuationKey,
      fingerprint,
    );
  }

  release(sessionId: string, generation: number): void {
    const session = this.sessionsOrNull(sessionId);
    if (!session || session.cwdTransitionGeneration !== generation) return;
    session.cwdTransitionGeneration = null;
    if (!session.turnLoopRunning && session.pendingMessages.length > 0) {
      void this.context.runTurnLoop(session, sessionId);
    }
  }

  runtimeCwd(sessionId: string): string | null {
    return this.sessionsOrNull(sessionId)?.cwd ?? null;
  }

  private requeueSubmittingSteer(session: InternalSession): void {
    const submitting = session.submittingUserMessage;
    if (!submitting || submitting.kind !== 'steer' || submitting.cancelled) return;
    submitting.cancelled = true;
    submitting.requestController?.abort();
    if (session.submittingUserMessage === submitting) {
      session.submittingUserMessage = null;
    }
    const pendingCount = session.pendingMessages.length;
    session.pendingMessages.unshift(
      packCodexInput(submitting.event.text, submitting.event.attachments),
    );
    const deferred = (session.pendingDeferredUserEvents ??= Array.from(
      { length: pendingCount },
      () => null,
    ));
    while (deferred.length < pendingCount) deferred.push(null);
    deferred.unshift({ ...submitting.event });
    const handOff = (session.pendingHandOffMessages ??= Array.from(
      { length: pendingCount },
      () => null,
    ));
    while (handOff.length < pendingCount) handOff.push(null);
    handOff.unshift({
      text: submitting.event.text,
      ...(submitting.event.attachments
        ? { attachments: submitting.event.attachments.map((ref) => ({ ...ref })) }
        : {}),
    });
  }

  private requireArmed(transition: AgentCwdTransition): InternalSession {
    const session = this.requireSession(transition.sessionId);
    if (session.cwdTransitionGeneration !== transition.generation) {
      throw new Error(
        `Codex cwd transition ${transition.sessionId}:${transition.generation} is not armed.`,
      );
    }
    return session;
  }

  private requireSession(sessionId: string): InternalSession {
    const session = this.sessionsOrNull(sessionId);
    if (!session) {
      throw new Error(`Codex session ${sessionId} is not live.`);
    }
    return session;
  }

  private sessionsOrNull(sessionId: string): InternalSession | null {
    return this.context.sessions.get(sessionId) ?? null;
  }
}
