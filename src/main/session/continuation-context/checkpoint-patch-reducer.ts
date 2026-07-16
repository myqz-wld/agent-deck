import {
  CONTINUATION_CHECKPOINT_SECTIONS,
  MAX_CHECKPOINT_EVIDENCE_PER_FACT,
  MAX_CHECKPOINT_FACTS_PER_SECTION,
  canonicalizeContinuationCheckpoint,
  type CanonicalContinuationCheckpoint,
  type ContinuationCheckpoint,
  type ContinuationCheckpointSection,
  type ContinuationEvidence,
  type ContinuationFact,
} from './checkpoint-schema';
import {
  continuationCheckpointPatchSchema,
  type ContinuationCheckpointPatch,
} from './checkpoint-patch-schema';
import { COVERAGE_GAP_FACT_ID_PREFIX } from './checkpoint-fold-coverage-gap';
import {
  CheckpointPatchValidationError,
  checkpointPatchSchemaError,
  type CheckpointPatchValidationIssue,
} from './checkpoint-patch-validation';

function evidenceKey(evidence: ContinuationEvidence): string {
  return `${evidence.eventId}:${evidence.revision}`;
}

function emptyCheckpoint(): ContinuationCheckpoint {
  return Object.fromEntries([
    ['formatVersion', 1],
    ...CONTINUATION_CHECKPOINT_SECTIONS.map((section) => [section, []]),
  ]) as unknown as ContinuationCheckpoint;
}

function optionalText(value: string): string | undefined {
  return value.length > 0 ? value : undefined;
}

function currentEvidenceIssues(
  input: {
    label: string;
    path: string;
  },
  evidence: ContinuationEvidence[],
  currentEvidence: Set<string>,
): CheckpointPatchValidationIssue[] {
  const issues: CheckpointPatchValidationIssue[] = [];
  const seen = new Set<string>();
  evidence.forEach((item, index) => {
    const key = evidenceKey(item);
    if (!currentEvidence.has(key)) {
      issues.push({
        code: 'evidence.outside-current-delta',
        path: `${input.path}.evidence[${index}]`,
        message: `${input.label} cites ${key}, which is not in currentDeltaEvidence.`,
        requiredAction:
          'Remove this pair. If no valid cited pair remains, remove the whole operation; never substitute unrelated evidence.',
      });
    }
    if (seen.has(key)) {
      issues.push({
        code: 'evidence.duplicate',
        path: `${input.path}.evidence[${index}]`,
        message: `${input.label} repeats evidence pair ${key}.`,
        requiredAction: 'Keep each evidence pair at most once in this operation.',
      });
    }
    seen.add(key);
  });
  return issues;
}

function mergeEvidence(
  previous: ContinuationEvidence[],
  current: ContinuationEvidence[],
): ContinuationEvidence[] {
  const unique = new Map<string, ContinuationEvidence>();
  for (const evidence of [...previous, ...current]) unique.set(evidenceKey(evidence), evidence);
  return [...unique.values()]
    .sort((left, right) => left.revision - right.revision || left.eventId - right.eventId)
    .slice(-MAX_CHECKPOINT_EVIDENCE_PER_FACT);
}

function sameSemantics(left: ContinuationFact, right: ContinuationFact): boolean {
  return (
    left.status === right.status &&
    left.text === right.text &&
    left.rationale === right.rationale &&
    left.validation === right.validation &&
    left.priority === right.priority
  );
}

function replacementFact(input: {
  prior: ContinuationFact;
  update: ContinuationCheckpointPatch['updates'][number];
}): ContinuationFact {
  const rationale =
    input.update.rationale === null
      ? input.prior.rationale
      : optionalText(input.update.rationale);
  const validation =
    input.update.validation === null
      ? input.prior.validation
      : optionalText(input.update.validation);
  return {
    id: input.update.id,
    status: input.update.status ?? input.prior.status,
    text: input.update.text ?? input.prior.text,
    ...(rationale ? { rationale } : {}),
    ...(validation ? { validation } : {}),
    priority: input.update.priority ?? input.prior.priority,
    evidence: mergeEvidence(input.prior.evidence, input.update.evidence),
  };
}

function cloneCheckpoint(previous: ContinuationCheckpoint | null): ContinuationCheckpoint {
  const source = previous ?? emptyCheckpoint();
  return Object.fromEntries([
    ['formatVersion', 1],
    ...CONTINUATION_CHECKPOINT_SECTIONS.map((section) => [section, [...source[section]]]),
  ]) as unknown as ContinuationCheckpoint;
}

function factLocations(
  checkpoint: ContinuationCheckpoint,
): Map<string, ContinuationCheckpointSection> {
  const locations = new Map<string, ContinuationCheckpointSection>();
  for (const section of CONTINUATION_CHECKPOINT_SECTIONS) {
    for (const fact of checkpoint[section]) locations.set(fact.id, section);
  }
  return locations;
}

/** Apply model-inferred mutations while the application retains ownership of all unchanged state. */
export function applyContinuationCheckpointPatch(input: {
  previousCheckpoint: ContinuationCheckpoint | null;
  patch: ContinuationCheckpointPatch;
  currentDeltaEvidence: ContinuationEvidence[];
}): CanonicalContinuationCheckpoint {
  const parsed = continuationCheckpointPatchSchema.safeParse(input.patch);
  if (!parsed.success) throw checkpointPatchSchemaError(parsed.error);
  const patch = parsed.data;
  const currentEvidence = new Set(input.currentDeltaEvidence.map(evidenceKey));
  const next = cloneCheckpoint(input.previousCheckpoint);
  const locations = factLocations(next);

  const issues: CheckpointPatchValidationIssue[] = [];
  patch.updates.forEach((update, index) => {
    const path = `$.updates[${index}]`;
    if (update.id.startsWith(COVERAGE_GAP_FACT_ID_PREFIX)) {
      issues.push({
        code: 'fact.reserved-id',
        path: `${path}.id`,
        message: `Coverage marker ${update.id} is app-owned.`,
        requiredAction: 'Remove this update; the application preserves coverage markers.',
      });
    }
    issues.push(
      ...currentEvidenceIssues(
        { label: `Checkpoint update ${update.id}`, path },
        update.evidence,
        currentEvidence,
      ),
    );
    const actualSection = locations.get(update.id);
    if (!actualSection) {
      issues.push({
        code: 'update.unknown-fact',
        path: `${path}.id`,
        message: `No existing fact has id ${update.id}.`,
        requiredAction: 'Remove this update; repair input cannot safely infer a complete new fact.',
      });
      return;
    }
    if (actualSection !== update.section) {
      issues.push({
        code: 'update.section-mismatch',
        path: `${path}.section`,
        message: `Fact ${update.id} is in ${actualSection}, not ${update.section}.`,
        requiredAction: `Set section to ${actualSection}; facts cannot move between sections.`,
      });
      return;
    }
    const prior = next[actualSection].find((fact) => fact.id === update.id)!;
    if (sameSemantics(prior, replacementFact({ prior, update }))) {
      issues.push({
        code: 'update.no-semantic-change',
        path,
        message: `Update ${update.id} repeats its existing semantic state.`,
        requiredAction: 'Remove this update; unchanged facts must be omitted from the patch.',
      });
    }
  });

  const additionsPerSection = new Map<ContinuationCheckpointSection, number>();
  patch.additions.forEach((addition, index) => {
    const path = `$.additions[${index}]`;
    const fact = addition.fact;
    if (fact.id.startsWith(COVERAGE_GAP_FACT_ID_PREFIX)) {
      issues.push({
        code: 'fact.reserved-id',
        path: `${path}.fact.id`,
        message: `Coverage marker ${fact.id} is app-owned.`,
        requiredAction: 'Remove this addition; only the application creates coverage markers.',
      });
    }
    issues.push(
      ...currentEvidenceIssues(
        { label: `Checkpoint addition ${fact.id}`, path: `${path}.fact` },
        fact.evidence,
        currentEvidence,
      ),
    );
    const actualSection = locations.get(fact.id);
    if (actualSection) {
      issues.push({
        code: 'addition.existing-fact',
        path: `${path}.fact.id`,
        message: `Fact ${fact.id} already exists in ${actualSection}.`,
        requiredAction:
          'Remove this addition; repair input cannot safely derive a field-level update.',
      });
    }
    additionsPerSection.set(
      addition.section,
      (additionsPerSection.get(addition.section) ?? 0) + 1,
    );
  });

  for (const [section, count] of additionsPerSection) {
    if (next[section].length + count <= MAX_CHECKPOINT_FACTS_PER_SECTION) continue;
    issues.push({
      code: 'addition.section-capacity',
      path: '$.additions',
      message: `${section} would exceed its ${MAX_CHECKPOINT_FACTS_PER_SECTION}-fact capacity.`,
      requiredAction: `Remove lower-value additions for ${section}; do not delete or rewrite existing facts.`,
    });
  }
  if (issues.length > 0) throw new CheckpointPatchValidationError(issues);

  for (const update of patch.updates) {
    const actualSection = locations.get(update.id)!;
    const index = next[actualSection].findIndex((fact) => fact.id === update.id);
    const prior = next[actualSection][index];
    next[actualSection][index] = replacementFact({ prior, update });
  }

  const additionsBySection = new Map<ContinuationCheckpointSection, ContinuationFact[]>();
  for (const addition of patch.additions) {
    const fact = addition.fact;
    const rationale = optionalText(fact.rationale);
    const validation = optionalText(fact.validation);
    const added: ContinuationFact = {
      id: fact.id,
      status: fact.status,
      text: fact.text,
      ...(rationale ? { rationale } : {}),
      ...(validation ? { validation } : {}),
      priority: fact.priority,
      evidence: [...fact.evidence].sort(
        (left, right) => left.revision - right.revision || left.eventId - right.eventId,
      ),
    };
    const additions = additionsBySection.get(addition.section) ?? [];
    additions.push(added);
    additionsBySection.set(addition.section, additions);
  }

  for (const section of CONTINUATION_CHECKPOINT_SECTIONS) {
    const additions = additionsBySection.get(section);
    if (!additions) continue;
    next[section] = [
      ...next[section],
      ...additions.sort((left, right) => left.id.localeCompare(right.id)),
    ];
  }

  return canonicalizeContinuationCheckpoint(next);
}
