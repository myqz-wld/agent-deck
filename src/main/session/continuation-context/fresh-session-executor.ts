import { adapterRegistry } from '@main/adapters/registry';
import type { CreateSessionOptions } from '@main/adapters/types';
import type { TrustedContinuationSessionCandidate } from '@main/adapters/trusted-continuation';
import { sessionManager } from '@main/session/manager';
import { isTrustedContinuationInitialTurn, type InternalInitialTurn } from './initial-turn';

function cleanFreshTarget(target: CreateSessionOptions): CreateSessionOptions {
  if (target.resume) throw new Error('Fresh-session executor does not accept resume');
  const cleanTarget = { ...target } as CreateSessionOptions & Record<string, unknown>;
  delete cleanTarget.trustedContinuation;
  delete cleanTarget.initialTurn;
  return cleanTarget;
}

/** Main-only trusted create path that retains the adapter-owned readiness boundary. */
export async function executeTrustedContinuationCandidate(
  target: CreateSessionOptions,
  initialTurn: Extract<InternalInitialTurn, { kind: 'trusted-continuation' }>,
): Promise<TrustedContinuationSessionCandidate> {
  const cleanTarget = cleanFreshTarget(target);
  const adapter = adapterRegistry.get(target.agentId);
  if (!isTrustedContinuationInitialTurn(initialTurn)) {
    throw new Error('Unbranded trusted continuation turn rejected');
  }
  if (!adapter?.createTrustedContinuationSession) {
    throw new Error(`adapter "${target.agentId}" does not support trusted continuation turns`);
  }
  delete cleanTarget.prompt;
  return adapter.createTrustedContinuationSession(cleanTarget, initialTurn);
}

/** Strict rollback close used before replacing a rejected uncommitted candidate. */
export async function rollbackTrustedContinuationCandidate(
  target: CreateSessionOptions,
  sessionId: string,
): Promise<void> {
  const adapter = adapterRegistry.get(target.agentId);
  if (!adapter?.closeSessionForRollback) {
    throw new Error(`adapter "${target.agentId}" cannot prove continuation rollback cleanup`);
  }
  await adapter.closeSessionForRollback(sessionId);
  await sessionManager.delete(sessionId);
}

/** Lower-level fresh executor shared by ordinary spawn and authenticated continuation workflows. */
export async function executeFreshSession(
  target: CreateSessionOptions,
  initialTurn: InternalInitialTurn,
): Promise<string> {
  const cleanTarget = cleanFreshTarget(target);
  const adapter = adapterRegistry.get(target.agentId);
  if (!adapter?.createSession) throw new Error(`adapter "${target.agentId}" cannot create sessions`);
  if (initialTurn.kind === 'ordinary') {
    return adapter.createSession({ ...cleanTarget, prompt: initialTurn.prompt });
  }
  return (await executeTrustedContinuationCandidate(target, initialTurn)).sessionId;
}
