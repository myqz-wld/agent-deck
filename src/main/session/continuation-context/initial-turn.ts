import { MAX_USER_MESSAGE_LENGTH } from '@shared/message-limits';
import { assertContinuationPromptByteLimit } from './budget-policy';
import { estimateContinuationTokens } from './token-estimator';
import type { PreparedContinuationContext } from './types';

const TRUSTED_CONTINUATION_TURN = Symbol('agent-deck.trusted-continuation-turn');

export interface OrdinaryInitialTurn {
  kind: 'ordinary';
  prompt: string;
}

export interface TrustedContinuationMetadata {
  formatVersion: number;
  checkpointId: number | null;
  sourceSessionId: string;
  sourceEventRevision: number;
  preparationHash: string;
  messageOrigin: 'continuation';
}

export interface TrustedContinuationInitialTurn {
  kind: 'trusted-continuation';
  providerPrompt: string;
  persistedUserText: string;
  metadata: TrustedContinuationMetadata;
  /** Trusted target-side capacity resolved in main; never sourced from renderer/MCP input. */
  targetPromptCapacityTokens: number;
  readonly [TRUSTED_CONTINUATION_TURN]: true;
}

export type InternalInitialTurn = OrdinaryInitialTurn | TrustedContinuationInitialTurn;

export function createOrdinaryInitialTurn(prompt: string): OrdinaryInitialTurn {
  if (!prompt.trim()) throw new Error('Ordinary initial prompt must not be empty');
  if (prompt.length > MAX_USER_MESSAGE_LENGTH) {
    throw new Error(`Ordinary initial prompt exceeds ${MAX_USER_MESSAGE_LENGTH} characters`);
  }
  return { kind: 'ordinary', prompt };
}

export function createTrustedContinuationInitialTurn(
  prepared: PreparedContinuationContext,
  sourceSessionId: string,
): TrustedContinuationInitialTurn {
  if (!prepared.persistedUserText.trim()) {
    throw new Error('Trusted continuation persisted user text must not be empty');
  }
  if (prepared.persistedUserText.length > MAX_USER_MESSAGE_LENGTH) {
    throw new Error(
      `Trusted continuation instruction exceeds ${MAX_USER_MESSAGE_LENGTH} characters`,
    );
  }
  assertContinuationPromptByteLimit(prepared.providerPrompt);
  const estimated = estimateContinuationTokens(prepared.providerPrompt);
  if (estimated > prepared.metrics.targetPromptCapacityTokens) {
    throw new Error(
      `Trusted continuation prompt requires ${estimated} estimated tokens, exceeding target capacity ${prepared.metrics.targetPromptCapacityTokens}`,
    );
  }
  const metadata: TrustedContinuationMetadata = Object.freeze({
    formatVersion: prepared.version,
    checkpointId: prepared.checkpoint.id,
    sourceSessionId,
    sourceEventRevision: prepared.source.eventRevision,
    preparationHash: prepared.preparationHash,
    messageOrigin: 'continuation',
  });
  return Object.freeze({
    kind: 'trusted-continuation',
    providerPrompt: prepared.providerPrompt,
    persistedUserText: prepared.persistedUserText,
    metadata,
    targetPromptCapacityTokens: prepared.metrics.targetPromptCapacityTokens,
    [TRUSTED_CONTINUATION_TURN]: true as const,
  });
}

export function isTrustedContinuationInitialTurn(
  value: unknown,
): value is TrustedContinuationInitialTurn {
  return (
    !!value &&
    typeof value === 'object' &&
    (value as Partial<TrustedContinuationInitialTurn>).kind === 'trusted-continuation' &&
    (value as Record<PropertyKey, unknown>)[TRUSTED_CONTINUATION_TURN] === true
  );
}

export interface ResolvedInternalInitialTurn {
  providerPrompt: string;
  persistedUserText: string;
  metadata: TrustedContinuationMetadata | null;
  trusted: boolean;
}

export function resolveInternalInitialTurn(input: {
  prompt?: string;
  trustedContinuation?: TrustedContinuationInitialTurn;
}): ResolvedInternalInitialTurn {
  if (input.trustedContinuation !== undefined) {
    if (!isTrustedContinuationInitialTurn(input.trustedContinuation)) {
      throw new Error('Untrusted continuation initial turn rejected');
    }
    if (input.prompt !== undefined && input.prompt !== input.trustedContinuation.providerPrompt) {
      throw new Error('Trusted continuation cannot be combined with a different public prompt');
    }
    assertContinuationPromptByteLimit(input.trustedContinuation.providerPrompt);
    const estimated = estimateContinuationTokens(input.trustedContinuation.providerPrompt);
    if (estimated > input.trustedContinuation.targetPromptCapacityTokens) {
      throw new Error('Trusted continuation prompt no longer fits its frozen target capacity');
    }
    return {
      providerPrompt: input.trustedContinuation.providerPrompt,
      persistedUserText: input.trustedContinuation.persistedUserText,
      metadata: input.trustedContinuation.metadata,
      trusted: true,
    };
  }
  const prompt = input.prompt ?? '';
  return {
    providerPrompt: createOrdinaryInitialTurn(prompt).prompt,
    persistedUserText: prompt,
    metadata: null,
    trusted: false,
  };
}

export function continuationMessagePayload(
  turn: ResolvedInternalInitialTurn,
): Record<string, unknown> {
  return turn.metadata
    ? {
        messageOrigin: 'continuation',
        continuation: { ...turn.metadata },
      }
    : {};
}
