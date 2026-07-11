import { adapterRegistry } from '@main/adapters/registry';
import type { CreateSessionOptions } from '@main/adapters/types';
import { isTrustedContinuationInitialTurn, type InternalInitialTurn } from './initial-turn';

/** Lower-level fresh executor shared by ordinary spawn and authenticated continuation workflows. */
export async function executeFreshSession(
  target: CreateSessionOptions,
  initialTurn: InternalInitialTurn,
): Promise<string> {
  if (target.resume) throw new Error('Fresh-session executor does not accept resume');
  const adapter = adapterRegistry.get(target.agentId);
  if (!adapter?.createSession) throw new Error(`adapter "${target.agentId}" cannot create sessions`);
  const cleanTarget = { ...target } as CreateSessionOptions & Record<string, unknown>;
  delete cleanTarget.trustedContinuation;
  delete cleanTarget.initialTurn;
  if (initialTurn.kind === 'ordinary') {
    return adapter.createSession({ ...cleanTarget, prompt: initialTurn.prompt });
  }
  if (!isTrustedContinuationInitialTurn(initialTurn)) {
    throw new Error('Unbranded trusted continuation turn rejected');
  }
  if (!adapter.createTrustedContinuationSession) {
    throw new Error(`adapter "${target.agentId}" does not support trusted continuation turns`);
  }
  delete cleanTarget.prompt;
  return adapter.createTrustedContinuationSession(cleanTarget, initialTurn);
}
