import { createHash } from 'node:crypto';
import type { RawEventRevisionRow } from '@main/store/event-revision-repo';
import { normalizeContinuationEvent } from './event-normalizer';
import {
  buildCheckpointFoldPrompt,
  CONTINUATION_CHECKPOINT_SYSTEM_PROMPT,
} from './checkpoint-prompts';
import { projectContinuationCheckpointForFold } from './checkpoint-projection';
import {
  CONTINUATION_CHECKPOINT_SECTIONS,
  type ContinuationCheckpoint,
} from './checkpoint-schema';
import { estimateContinuationTokens, truncateContinuationTextMiddle } from './token-estimator';

const COMPACT_EDGE_TOKENS = 512;

export interface RevisionGroup {
  revision: number;
  rows: RawEventRevisionRow[];
  normalized: unknown[];
}

export interface FoldChunk {
  groups: RevisionGroup[];
  normalized: unknown[];
  currentEvidence: Array<{ eventId: number; revision: number }>;
  throughRevision: number;
  prompt: string;
  previousForFold: ContinuationCheckpoint | null;
  omittedPriorFacts: number;
  requiresCoverageMarker: boolean;
}

export function priorCheckpointEvidence(
  checkpoint: ContinuationCheckpoint | null,
): Array<{ eventId: number; revision: number }> {
  if (!checkpoint) return [];
  const unique = new Map<string, { eventId: number; revision: number }>();
  for (const section of CONTINUATION_CHECKPOINT_SECTIONS) {
    for (const fact of checkpoint[section]) {
      for (const evidence of fact.evidence) {
        unique.set(`${evidence.eventId}:${evidence.revision}`, evidence);
      }
    }
  }
  return [...unique.values()].sort(
    (left, right) => left.revision - right.revision || left.eventId - right.eventId,
  );
}

export function groupContinuationRows(rows: RawEventRevisionRow[]): RevisionGroup[] {
  const groups: RevisionGroup[] = [];
  for (const row of rows) {
    let group = groups.at(-1);
    if (!group || group.revision !== row.effectiveRevision) {
      group = { revision: row.effectiveRevision, rows: [], normalized: [] };
      groups.push(group);
    }
    group.rows.push(row);
    const normalized = normalizeContinuationEvent(row);
    if (normalized) group.normalized.push(normalized);
  }
  return groups;
}

function compactEventEdge(event: unknown): unknown {
  const value = event as {
    eventId?: unknown;
    effectiveRevision?: unknown;
    kind?: unknown;
    ts?: unknown;
    payload?: unknown;
    sourceBytes?: unknown;
    sourceHash?: unknown;
    truncated?: unknown;
  };
  const boundedPayload = truncateContinuationTextMiddle(
    JSON.stringify(value.payload ?? null),
    COMPACT_EDGE_TOKENS,
  );
  return {
    eventId: value.eventId ?? null,
    effectiveRevision: value.effectiveRevision ?? null,
    kind: value.kind ?? null,
    ts: value.ts ?? null,
    payloadJson: boundedPayload.text,
    payloadTruncatedForFold: boundedPayload.truncated,
    sourceBytes: value.sourceBytes ?? null,
    sourceHash: value.sourceHash ?? null,
    sourceWasTruncated: value.truncated ?? null,
  };
}

function compactOversizedGroup(group: RevisionGroup): unknown[] {
  const digest = createHash('sha256');
  group.rows.forEach((row) =>
    digest.update(`${row.id}:${row.effectiveRevision}:${row.payloadJson}\n`),
  );
  const edgeEvents =
    group.normalized.length <= 1
      ? group.normalized
      : [group.normalized[0], group.normalized.at(-1)];
  return [
    {
      type: 'bounded-revision-group',
      revision: group.revision,
      eventCount: group.rows.length,
      firstEventId: group.rows[0]?.id ?? null,
      lastEventId: group.rows.at(-1)?.id ?? null,
      sourceSha256: digest.digest('hex'),
      retainedEdges: edgeEvents.filter(Boolean).map(compactEventEdge),
    },
  ];
}

function promptTokens(prompt: string): number {
  return (
    estimateContinuationTokens(CONTINUATION_CHECKPOINT_SYSTEM_PROMPT) +
    estimateContinuationTokens(prompt)
  );
}

export function buildCheckpointFoldChunk(input: {
  groups: RevisionGroup[];
  previous: ContinuationCheckpoint | null;
  finalThroughRevision: number;
  budget: number;
}): FoldChunk | null {
  const baseEvidence = priorCheckpointEvidence(input.previous);
  let selected: RevisionGroup[] = [];
  let normalized: unknown[] = [];
  let currentEvidence: Array<{ eventId: number; revision: number }> = [];
  let best: FoldChunk | null = null;
  for (let index = 0; index < input.groups.length; index += 1) {
    const group = input.groups[index];
    const groupEvidence = group.normalized.map((event) => {
      const value = event as { eventId: number; effectiveRevision: number };
      return { eventId: value.eventId, revision: value.effectiveRevision };
    });
    selected = [...selected, group];
    normalized = [...normalized, ...group.normalized];
    currentEvidence = [...currentEvidence, ...groupEvidence];
    const throughRevision =
      index === input.groups.length - 1 ? input.finalThroughRevision : group.revision;
    let prompt = buildCheckpointFoldPrompt({
      previousCheckpoint: input.previous,
      sourceThroughRevision: throughRevision,
      normalizedDelta: normalized,
      allowedEvidence: [...baseEvidence, ...currentEvidence],
    });
    if (
      promptTokens(prompt) > input.budget &&
      selected.length === 1 &&
      group.normalized.length > 0
    ) {
      normalized = compactOversizedGroup(group);
      prompt = buildCheckpointFoldPrompt({
        previousCheckpoint: input.previous,
        sourceThroughRevision: throughRevision,
        normalizedDelta: normalized,
        allowedEvidence: [...baseEvidence, ...currentEvidence],
      });
    }
    if (promptTokens(prompt) > input.budget) {
      if (selected.length !== 1) return best;
      if (!input.previous) {
        return {
          groups: selected,
          normalized: compactOversizedGroup(group),
          currentEvidence,
          throughRevision,
          prompt: '',
          previousForFold: null,
          omittedPriorFacts: 0,
          requiresCoverageMarker: true,
        };
      }
      let low = 0;
      // Search the whole prior-projection range; the final system+prompt estimate below is the
      // authority for how much room the concrete delta actually needs.
      let high = input.budget;
      let projectedBest: FoldChunk | null = null;
      while (low <= high) {
        const midpoint = Math.floor((low + high) / 2);
        const projection = projectContinuationCheckpointForFold(input.previous, midpoint);
        if (!projection.preservesActiveFacts) {
          low = midpoint + 1;
          continue;
        }
        const projectedEvidence = priorCheckpointEvidence(projection.checkpoint);
        const projectedPrompt = buildCheckpointFoldPrompt({
          previousCheckpoint: projection.checkpoint,
          sourceThroughRevision: throughRevision,
          normalizedDelta: normalized,
          allowedEvidence: [...projectedEvidence, ...currentEvidence],
        });
        if (promptTokens(projectedPrompt) <= input.budget) {
          projectedBest = {
            groups: selected,
            normalized,
            currentEvidence,
            throughRevision,
            prompt: projectedPrompt,
            previousForFold: projection.checkpoint,
            omittedPriorFacts: projection.omittedFacts,
            requiresCoverageMarker: false,
          };
          low = midpoint + 1;
        } else {
          high = midpoint - 1;
        }
      }
      return projectedBest ?? {
        groups: selected,
        normalized: compactOversizedGroup(group),
        currentEvidence,
        throughRevision,
        prompt: '',
        previousForFold: input.previous,
        omittedPriorFacts: 0,
        requiresCoverageMarker: true,
      };
    }
    best = {
      groups: selected,
      normalized,
      currentEvidence,
      throughRevision,
      prompt,
      previousForFold: input.previous,
      omittedPriorFacts: 0,
      requiresCoverageMarker: false,
    };
  }
  return best;
}
