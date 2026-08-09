import { basename, isAbsolute, relative, resolve, sep } from 'node:path';

import { getDb } from '@main/store/db';
import {
  DEFAULT_CONTINUATION_RAW_RETENTION_TOKENS,
  resolveContinuationBudgets,
} from '@main/session/continuation-context/budget-policy';
import type { FoldContinuationCheckpointResult } from '@main/session/continuation-context/checkpoint-fold';
import {
  createTrustedContinuationInitialTurn,
  type TrustedContinuationInitialTurn,
} from '@main/session/continuation-context/initial-turn';
import { renderPreparedContinuation } from '@main/session/continuation-context/preparation-renderer';
import { renderContinuationContext } from '@main/session/continuation-context/renderer';
import { ContinuationSourceSpoolStore } from '@main/session/continuation-context/source-spool';
import { estimateContinuationTokens } from '@main/session/continuation-context/token-estimator';
import type {
  ContinuationWarning,
  PrepareContinuationContextInput,
  PreparedContinuationContext,
  RawContinuationUserInput,
  ResolvedContinuationGenerator,
  ResolvedSuccessorSpec,
} from '@main/session/continuation-context/types';

const UNKNOWN_CAPACITY = Object.freeze({
  status: 'unknown' as const,
  identity: null,
  windowTokens: null,
  reason: 'no-observation' as const,
});

export interface PreparedServerCoreHandOffContinuation {
  readonly prepared: PreparedContinuationContext;
  readonly turn: TrustedContinuationInitialTurn;
  readonly lowerBudgetRetry: {
    readonly prepared: PreparedContinuationContext;
    readonly turn: TrustedContinuationInitialTurn;
  };
  readonly sourcePrecondition: {
    readonly eventRevision: number;
    readonly rebuildAfterRevision: number;
    readonly maxEventId: number | null;
    readonly runtimeFingerprint: string;
  };
  cleanup(): void;
}

function inside(root: string, target: string): boolean {
  const child = relative(resolve(root), resolve(target));
  return child === '' || (
    child !== '..' && !child.startsWith(`..${sep}`) && !isAbsolute(child)
  );
}

function safeRawInputs(
  rows: RawContinuationUserInput[],
  workspaceRoot: string,
): RawContinuationUserInput[] {
  return rows.map((row) => ({
    ...row,
    attachments: row.attachments.map((attachment) => {
      const path = attachment.path;
      if (!path) return { ...attachment };
      if (isAbsolute(path) && inside(workspaceRoot, path)) {
        const token = relative(workspaceRoot, path).split(sep).join('/');
        return { ...attachment, path: token ? `Workspace/${token}` : 'Workspace' };
      }
      return {
        ...(attachment.name ? { name: attachment.name } : { name: basename(path) }),
        ...(attachment.mimeType ? { mimeType: attachment.mimeType } : {}),
      };
    }),
  }));
}

function fixedWrapperTokens(input: {
  instruction: string;
}): number {
  const rendered = renderContinuationContext({
    quality: 'instruction-only',
    checkpoint: null,
    rawUserInputs: [],
    continuationInstruction: input.instruction,
  });
  return Math.max(
    0,
    rendered.estimatedTokens - estimateContinuationTokens(JSON.stringify(input.instruction)),
  );
}

function baseWarnings(input: {
  uncovered: { from: number; to: number } | null;
  rawScanTruncated: boolean;
  rawWarnings: readonly 'context-wrapper-excluded'[];
}): ContinuationWarning[] {
  const warnings: ContinuationWarning[] = [{
    code: 'target-capacity-fallback',
    message: 'Target capacity is unknown; using tagged 64k primary and 32k retry policies.',
  }];
  if (input.uncovered || input.rawScanTruncated) {
    warnings.push({
      code: 'spool-resource-guard',
      message: 'The immutable source spool has an explicit bounded coverage gap.',
    });
  }
  for (const code of input.rawWarnings) {
    warnings.push({
      code,
      message: 'A generated continuation context was excluded from retained history.',
    });
  }
  return warnings;
}

function generator(target: ResolvedSuccessorSpec): ResolvedContinuationGenerator {
  return {
    adapter: target.adapter,
    provider: target.provider ?? null,
    model: target.model,
    thinking: target.thinking ?? 'medium',
    contextCapacity: UNKNOWN_CAPACITY,
    configFingerprint: target.runtimeFingerprint,
  };
}

/** Captures the immutable source synchronously and renders bounded Core-owned candidates. */
export function prepareServerCoreHandOffContinuation(input: {
  readonly sourceSessionId: string;
  readonly instruction: string;
  readonly target: ResolvedSuccessorSpec;
  readonly workspaceRoot: string;
}): PreparedServerCoreHandOffContinuation {
  const spool = new ContinuationSourceSpoolStore(getDb());
  const metadata = spool.capture({
    sessionId: input.sourceSessionId,
    rawRetentionCeilingTokens: DEFAULT_CONTINUATION_RAW_RETENTION_TOKENS,
  });
  try {
    const raw = safeRawInputs(spool.readRawInputs(metadata.spoolId), input.workspaceRoot);
    const uncovered = metadata.uncoveredRevisionRange ?? (
      metadata.checkpoint && metadata.checkpointThroughRevision < metadata.captureRevision
        ? { from: metadata.checkpointThroughRevision, to: metadata.captureRevision }
        : null
    );
    const fold: FoldContinuationCheckpointResult = {
      checkpoint: metadata.checkpoint,
      refreshed: false,
      foldCalls: 0,
      repairCalls: 0,
      inputTokens: 0,
      outputTokens: 0,
      observedContextWindowEvidence: null,
      warnings: [],
      failure: null,
      uncoveredRevisionRange: uncovered,
    };
    const request: PrepareContinuationContextInput = {
      purpose: 'handoff',
      sourceSessionId: input.sourceSessionId,
      continuationInstruction: input.instruction,
      generator: generator(input.target),
      target: input.target,
      source: { mode: 'immutable-spool', spoolId: metadata.spoolId },
      limits: {
        rawRetentionCeilingTokens: DEFAULT_CONTINUATION_RAW_RETENTION_TOKENS,
        deadlineMs: 90_000,
        maxFoldCalls: 0,
        maxRepairCalls: 0,
      },
    };
    const fixed = fixedWrapperTokens({
      instruction: input.instruction,
    });
    const warnings = baseWarnings({
      uncovered,
      rawScanTruncated: metadata.rawScanTruncated,
      rawWarnings: metadata.rawWarnings,
    });
    const primaryBudgets = resolveContinuationBudgets({
      rawRetentionCeilingTokens: DEFAULT_CONTINUATION_RAW_RETENTION_TOKENS,
      targetCapacity: UNKNOWN_CAPACITY,
      generatorCapacity: UNKNOWN_CAPACITY,
      continuationInstruction: input.instruction,
      fixedWrapperTokens: fixed,
    });
    const retryBudgets = resolveContinuationBudgets({
      rawRetentionCeilingTokens: DEFAULT_CONTINUATION_RAW_RETENTION_TOKENS,
      targetCapacity: UNKNOWN_CAPACITY,
      generatorCapacity: UNKNOWN_CAPACITY,
      targetVariant: 'lower-budget-retry',
      continuationInstruction: input.instruction,
      fixedWrapperTokens: fixed,
    });
    const render = (budgets: typeof primaryBudgets) => renderPreparedContinuation({
      request,
      metadata,
      fold,
      budgets,
      capturedRaw: raw,
      baseWarnings: warnings,
      elapsedMs: 0,
    });
    const prepared = render(primaryBudgets);
    const lowerPrepared = render(retryBudgets);
    return {
      prepared,
      turn: createTrustedContinuationInitialTurn(prepared, input.sourceSessionId),
      lowerBudgetRetry: {
        prepared: lowerPrepared,
        turn: createTrustedContinuationInitialTurn(lowerPrepared, input.sourceSessionId),
      },
      sourcePrecondition: {
        eventRevision: metadata.captureRevision,
        rebuildAfterRevision: metadata.rebuildAfterRevision,
        maxEventId: metadata.maxEventId,
        runtimeFingerprint: metadata.runtimeFingerprint,
      },
      cleanup: () => spool.cleanup(metadata.spoolId),
    };
  } catch (error) {
    spool.cleanup(metadata.spoolId);
    throw error;
  }
}
