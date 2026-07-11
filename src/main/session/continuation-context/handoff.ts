import {
  createTrustedContinuationInitialTurn,
  type TrustedContinuationInitialTurn,
} from './initial-turn';
import {
  continuationFingerprint,
  resolveContinuationGeneratorSnapshot,
  resolveContinuationRawRetentionCeiling,
} from './resolver';
import { prepareContinuationContext } from './service';
import type {
  PreparedContinuationContext,
  ResolvedContinuationGenerator,
  ResolvedSuccessorSpec,
} from './types';

export const HANDOFF_CONTINUATION_DEADLINE_MS = 120_000;
export const HANDOFF_CONTINUATION_MAX_FOLD_CALLS = 4;
export const HANDOFF_CONTINUATION_MAX_REPAIR_CALLS = 1;

export interface PreparedHandOffContinuation {
  prepared: PreparedContinuationContext;
  turn: TrustedContinuationInitialTurn;
  generator: ResolvedContinuationGenerator;
  target: ResolvedSuccessorSpec;
  settingsFingerprint: string;
}

export function continuationPreparationSettingsFingerprint(input: {
  generator: ResolvedContinuationGenerator;
  rawRetentionCeilingTokens: number;
}): string {
  return continuationFingerprint({
    version: 1,
    generator: input.generator.configFingerprint,
    rawRetentionCeilingTokens: input.rawRetentionCeilingTokens,
  });
}

export function resolveContinuationPreparationSettingsFingerprint(): string {
  return continuationPreparationSettingsFingerprint({
    generator: resolveContinuationGeneratorSnapshot(),
    rawRetentionCeilingTokens: resolveContinuationRawRetentionCeiling(),
  });
}

export async function prepareHandOffContinuation(input: {
  sourceSessionId: string;
  continuationInstruction: string;
  target: ResolvedSuccessorSpec;
  signal?: AbortSignal;
}): Promise<PreparedHandOffContinuation> {
  // Resolve once before the first await so a settings edit cannot split one preparation across two
  // generator configurations. The core performs its SQLite TEMP capture synchronously before it
  // awaits provider work.
  const generator = resolveContinuationGeneratorSnapshot();
  const rawRetentionCeilingTokens = resolveContinuationRawRetentionCeiling();
  const settingsFingerprint = continuationPreparationSettingsFingerprint({
    generator,
    rawRetentionCeilingTokens,
  });
  const prepared = await prepareContinuationContext({
    purpose: 'handoff',
    sourceSessionId: input.sourceSessionId,
    continuationInstruction: input.continuationInstruction,
    generator,
    target: input.target,
    source: { mode: 'capture' },
    limits: {
      rawRetentionCeilingTokens,
      deadlineMs: HANDOFF_CONTINUATION_DEADLINE_MS,
      maxFoldCalls: HANDOFF_CONTINUATION_MAX_FOLD_CALLS,
      maxRepairCalls: HANDOFF_CONTINUATION_MAX_REPAIR_CALLS,
    },
    ...(input.signal ? { signal: input.signal } : {}),
  });
  return {
    prepared,
    turn: createTrustedContinuationInitialTurn(prepared, input.sourceSessionId),
    generator,
    target: input.target,
    settingsFingerprint,
  };
}
