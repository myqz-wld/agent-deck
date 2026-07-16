import { createHash } from 'node:crypto';
import type { RawEventRevisionRow } from '@main/store/event-revision-repo';
import { CONTINUATION_PROMPT_MAX_UTF8_BYTES } from './budget-policy';
import {
  MAX_NORMALIZED_EVENT_UTF8_BYTES,
  normalizeContinuationEvent,
} from './event-normalizer';
import {
  buildCheckpointFoldPrompt,
  CONTINUATION_CHECKPOINT_SYSTEM_PROMPT,
} from './checkpoint-prompts';
import { projectContinuationCheckpointForFold } from './checkpoint-projection';
import {
  type ContinuationCheckpoint,
  type ContinuationFact,
} from './checkpoint-schema';
import {
  estimateContinuationTokens,
  truncateContinuationTextMiddle,
  utf8ByteLength,
} from './token-estimator';

const COMPACT_EDGE_TOKENS = 512;
const COMPACT_TELEMETRY_EVENT_UTF8_BYTES = 256;
const COMPACT_TELEMETRY_EVENT_KINDS = new Set([
  'file-changed',
  'tool-use-end',
  'tool-use-start',
]);

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

/**
 * Bounded chunk view shared by the foreground fold and the background worker RPC.
 * Raw rows and the complete remaining group list deliberately never cross the worker boundary.
 */
export interface FoldChunkView {
  cursor: number;
  nextCursor: number;
  remainingAfter: boolean;
  consumedGroupCount: number;
  firstRevision: number;
  throughRevision: number;
  prompt: string;
  normalized: unknown[];
  currentEvidence: Array<{ eventId: number; revision: number }>;
  previousForFold: ContinuationCheckpoint | null;
  omittedPriorFacts: number;
  requiresCoverageMarker: boolean;
  coverageMarker: ContinuationFact | null;
}

export interface BuildFoldChunkViewInput {
  cursor: number;
  coveredThroughRevision: number;
  previous: ContinuationCheckpoint | null;
  budget: number;
}

export interface AsyncFoldChunkSource {
  buildNextChunk(input: BuildFoldChunkViewInput): Promise<FoldChunkView | null>;
}

function serializedToolInput(payloadJson: string): string | null {
  try {
    const payload = JSON.parse(payloadJson) as unknown;
    if (!payload || typeof payload !== 'object' || !Object.hasOwn(payload, 'toolInput')) {
      return null;
    }
    return JSON.stringify((payload as { toolInput: unknown }).toolInput) ?? null;
  } catch {
    return null;
  }
}

export function groupContinuationRows(rows: RawEventRevisionRow[]): RevisionGroup[] {
  // Codex completed-tool rows repeat the start row's tool input and add result/status. Retaining
  // both was the dominant fold amplifier in real handoffs. Deduplicate only when the serialized
  // inputs are byte-identical: Claude end rows often omit toolInput, and unmatched/in-flight starts
  // remain meaningful state.
  const completedToolInputs = new Map<string, string>();
  for (const row of rows) {
    if (row.kind !== 'tool-use-end' || !row.toolUseId) continue;
    const toolInput = serializedToolInput(row.payloadJson);
    if (toolInput !== null) completedToolInputs.set(row.toolUseId, toolInput);
  }
  const groups: RevisionGroup[] = [];
  for (const row of rows) {
    let group = groups.at(-1);
    if (!group || group.revision !== row.effectiveRevision) {
      group = { revision: row.effectiveRevision, rows: [], normalized: [] };
      groups.push(group);
    }
    group.rows.push(row);
    const duplicatedCompletedToolStart =
      row.kind === 'tool-use-start' &&
      row.toolUseId !== null &&
      serializedToolInput(row.payloadJson) === completedToolInputs.get(row.toolUseId);
    const normalized = duplicatedCompletedToolStart
      ? null
      : normalizeContinuationEvent(
          row,
          COMPACT_TELEMETRY_EVENT_KINDS.has(row.kind)
            ? COMPACT_TELEMETRY_EVENT_UTF8_BYTES
            : MAX_NORMALIZED_EVENT_UTF8_BYTES,
        );
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

function promptFits(prompt: string, tokenBudget: number): boolean {
  return promptTokens(prompt) <= tokenBudget &&
    utf8ByteLength(CONTINUATION_CHECKPOINT_SYSTEM_PROMPT) + utf8ByteLength(prompt) <=
      CONTINUATION_PROMPT_MAX_UTF8_BYTES;
}

export function buildCheckpointFoldChunk(input: {
  groups: RevisionGroup[];
  previous: ContinuationCheckpoint | null;
  finalThroughRevision: number;
  budget: number;
}): FoldChunk | null {
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
      currentDeltaEvidence: currentEvidence,
    });
    if (
      !promptFits(prompt, input.budget) &&
      selected.length === 1 &&
      group.normalized.length > 0
    ) {
      normalized = compactOversizedGroup(group);
      prompt = buildCheckpointFoldPrompt({
        previousCheckpoint: input.previous,
        sourceThroughRevision: throughRevision,
        normalizedDelta: normalized,
        currentDeltaEvidence: currentEvidence,
      });
    }
    if (!promptFits(prompt, input.budget)) {
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
        const projectedPrompt = buildCheckpointFoldPrompt({
          previousCheckpoint: projection.checkpoint,
          sourceThroughRevision: throughRevision,
          normalizedDelta: normalized,
          currentDeltaEvidence: currentEvidence,
        });
        if (promptFits(projectedPrompt, input.budget)) {
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
