import {
  CONTINUATION_CHECKPOINT_SECTIONS,
  type ContinuationFact,
} from './checkpoint-schema';
import { isCoverageGapFact } from './checkpoint-fold-coverage-gap';
import { estimateContinuationJsonTokens } from './token-estimator';
import type {
  CheckpointProjection,
  ContinuationQuality,
  RawContinuationUserInput,
} from './types';

export interface ProviderContinuationFact {
  status: ContinuationFact['status'];
  text: string;
  rationale?: string;
  validation?: string;
}

export interface ProviderCheckpointProjection {
  formatVersion: 1;
  omittedFacts?: number;
  facts: Partial<
    Record<(typeof CONTINUATION_CHECKPOINT_SECTIONS)[number], ProviderContinuationFact[]>
  >;
}

export interface ProviderRawUserInput {
  text: string;
  origin: RawContinuationUserInput['origin'];
  attachments?: Array<{ name?: string; mimeType?: string }>;
  truncated?: true;
}

export interface ProviderContinuationQuality {
  quality: ContinuationQuality;
  omittedCheckpointFacts?: number;
}

function providerFact(fact: ContinuationFact): ProviderContinuationFact {
  if (isCoverageGapFact(fact)) {
    return {
      status: 'blocked',
      text:
        'Some source history is represented only by a bounded integrity marker; ' +
        'full semantic coverage is unavailable.',
      rationale:
        'The complete source group could not share the checkpoint budget with required active facts.',
      validation:
        'Consult the persisted source history before relying on omitted assistant or tool state.',
    };
  }
  return {
    status: fact.status,
    text: fact.text,
    ...(fact.rationale ? { rationale: fact.rationale } : {}),
    ...(fact.validation ? { validation: fact.validation } : {}),
  };
}

function portableAttachmentLeaf(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  if (!trimmed) return undefined;
  const withoutTrailingSeparators = trimmed.replace(/[\\/]+$/u, '');
  const leaf = withoutTrailingSeparators.split(/[\\/]/u).at(-1)?.trim();
  if (!leaf || leaf === '.' || leaf === '..' || /^[A-Za-z]:$/u.test(leaf)) return undefined;
  return leaf;
}

/** Strip checkpoint provenance that a fresh provider session cannot resolve or act on. */
export function checkpointProjectionForProvider(
  projection: CheckpointProjection | null,
): ProviderCheckpointProjection | null {
  if (!projection) return null;
  const facts: ProviderCheckpointProjection['facts'] = {};
  for (const section of CONTINUATION_CHECKPOINT_SECTIONS) {
    const values = projection.facts[section];
    if (values && values.length > 0) facts[section] = values.map(providerFact);
  }
  return {
    formatVersion: projection.formatVersion,
    ...(projection.omittedFacts > 0 ? { omittedFacts: projection.omittedFacts } : {}),
    facts,
  };
}

/** Preserve useful attachment descriptions without disclosing host filesystem paths. */
export function rawUserInputForProvider(
  input: RawContinuationUserInput,
): ProviderRawUserInput {
  const attachments = input.attachments.flatMap((attachment) => {
    const name =
      portableAttachmentLeaf(attachment.name) ?? portableAttachmentLeaf(attachment.path);
    const value = {
      ...(name ? { name } : {}),
      ...(attachment.mimeType ? { mimeType: attachment.mimeType } : {}),
    };
    return Object.keys(value).length > 0 ? [value] : [];
  });
  return {
    text: input.text,
    origin: input.origin,
    ...(attachments.length > 0 ? { attachments } : {}),
    ...(input.truncated ? { truncated: true as const } : {}),
  };
}

export function rawUserInputsForProvider(
  inputs: readonly RawContinuationUserInput[],
): ProviderRawUserInput[] {
  return inputs.map(rawUserInputForProvider);
}

export function continuationQualityForProvider(input: {
  quality: ContinuationQuality;
  checkpoint: CheckpointProjection | null;
}): ProviderContinuationQuality {
  return {
    quality: input.quality,
    ...(input.checkpoint && input.checkpoint.omittedFacts > 0
      ? { omittedCheckpointFacts: input.checkpoint.omittedFacts }
      : {}),
  };
}

export function estimateProviderCheckpointTokens(
  projection: CheckpointProjection | null,
): number {
  const value = checkpointProjectionForProvider(projection);
  return value ? estimateContinuationJsonTokens(value, { structuralOverhead: 8 }) : 0;
}

export function estimateProviderRawInputTokens(input: RawContinuationUserInput): number {
  return estimateContinuationJsonTokens(rawUserInputForProvider(input), { structuralOverhead: 4 });
}
