import { createHash } from 'node:crypto';

import type { SessionHandOffPreviewResult } from '@contracts/index';
import { boundedContinuationPreview } from '@main/session/hand-off/ui-preparation-view';

import type { PreparedServerCoreHandOffContinuation } from './mcp-handoff-continuation';
import type { ServerCoreHandOffSessionArgs } from './mcp-handoff-port';
import type { ResolvedServerCoreHandOffTarget } from './mcp-handoff-target';

export function serverCoreHandOffBindingDigest(input: {
  sourceSessionId: string;
  args: ServerCoreHandOffSessionArgs;
  target: ResolvedServerCoreHandOffTarget;
  prepared: PreparedServerCoreHandOffContinuation;
}): string {
  const stable = {
    version: 1,
    sourceSessionId: input.sourceSessionId,
    instruction: input.args.prompt,
    target: {
      adapterId: input.target.adapterId,
      workingDirectory: input.target.cwdRef,
      capabilityRevision: input.target.capabilityRevision,
      options: input.target.options,
    },
    preparationHash: input.prepared.prepared.preparationHash,
    sourcePrecondition: input.prepared.sourcePrecondition,
  };
  return `sha256:${createHash('sha256').update(JSON.stringify(stable), 'utf8').digest('hex')}`;
}

export function serverCoreHandOffPreviewResult(input: {
  sourceSessionId: string;
  args: ServerCoreHandOffSessionArgs;
  target: ResolvedServerCoreHandOffTarget;
  prepared: PreparedServerCoreHandOffContinuation;
  revision: number;
}): SessionHandOffPreviewResult {
  const bounded = boundedContinuationPreview(input.prepared.prepared.providerPrompt);
  const value = input.prepared.prepared;
  return {
    bindingDigest: serverCoreHandOffBindingDigest(input),
    preview: bounded.preview,
    previewTruncated: bounded.truncated,
    quality: value.quality,
    source: {
      eventRevision: value.source.eventRevision,
      rebuildAfterRevision: value.source.rebuildAfterRevision,
    },
    checkpoint: { ...value.checkpoint },
    metrics: {
      estimatedPromptTokens: value.metrics.estimatedPromptTokens,
      checkpointTokens: value.metrics.checkpointTokens,
      rawTailTokens: value.metrics.rawTailTokens,
      includedUserMessages: value.metrics.includedUserMessages,
      truncatedBoundaryMessages: value.metrics.truncatedBoundaryMessages,
      rawRetentionCeilingTokens: value.metrics.rawRetentionCeilingTokens,
      elapsedMs: value.metrics.elapsedMs,
    },
    warnings: value.warnings.map(({ code, message }) => ({ code, message })),
    target: {
      adapterId: input.target.adapterId,
      workingDirectory: input.target.cwdRef,
      capabilityRevision: input.target.capabilityRevision,
      options: { ...input.target.options },
    },
    revision: input.revision,
  };
}
