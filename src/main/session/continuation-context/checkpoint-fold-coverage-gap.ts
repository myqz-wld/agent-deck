import { createHash } from 'node:crypto';
import type { RawEventRevisionRow } from '@main/store/event-revision-repo';
import {
  CONTINUATION_CHECKPOINT_SECTIONS,
  type ContinuationCheckpoint,
  type ContinuationFact,
} from './checkpoint-schema';

export const COVERAGE_GAP_FACT_ID_PREFIX = 'continuation.coverage-gap.';
const COVERAGE_GAP_FACT_ID = /^continuation\.coverage-gap\.after(\d+)\.r(\d+)\.[a-f0-9]{16}$/;

function evidenceKey(evidence: { eventId: number; revision: number }): string {
  return `${evidence.eventId}:${evidence.revision}`;
}

export interface CoverageGapSourceSummary {
  revision: number;
  eventCount: number;
  firstEventId: number;
  lastEventId: number;
  sourceSha256: string;
  evidence: Array<{ eventId: number; revision: number }>;
}

export function coverageGapDigestFrame(row: RawEventRevisionRow): string {
  const framed = JSON.stringify([
    row.id,
    row.effectiveRevision,
    row.kind,
    row.payloadJson,
    row.ts,
    row.toolUseId,
  ]);
  return `${Buffer.byteLength(framed, 'utf8')}:${framed}`;
}

function sourceDigest(rows: RawEventRevisionRow[]): string {
  const digest = createHash('sha256');
  for (const row of rows) digest.update(coverageGapDigestFrame(row));
  return digest.digest('hex');
}

export function isCoverageGapFact(fact: ContinuationFact): boolean {
  return fact.id.startsWith(COVERAGE_GAP_FACT_ID_PREFIX);
}

export function buildCoverageGapFact(input: {
  coveredThroughRevision: number;
  revision: number;
  rows: RawEventRevisionRow[];
  allowedEvidence: Array<{ eventId: number; revision: number }>;
}): ContinuationFact | null {
  if (
    input.rows.length === 0 ||
    input.allowedEvidence.length === 0 ||
    input.coveredThroughRevision >= input.revision
  ) {
    return null;
  }
  const digest = sourceDigest(input.rows);
  const uniqueEvidence = new Map(
    input.allowedEvidence.map((evidence) => [evidenceKey(evidence), evidence]),
  );
  const orderedEvidence = [...uniqueEvidence.values()].sort(
    (left, right) => left.revision - right.revision || left.eventId - right.eventId,
  );
  const rowEvidence = new Set(
    input.rows.map((row) => evidenceKey({ eventId: row.id, revision: row.effectiveRevision })),
  );
  if (
    input.rows.some((row) => row.effectiveRevision !== input.revision) ||
    orderedEvidence.some(
      (evidence) =>
        evidence.revision !== input.revision || !rowEvidence.has(evidenceKey(evidence)),
    )
  ) {
    return null;
  }
  const evidence =
    orderedEvidence.length === 1
      ? orderedEvidence
      : [orderedEvidence[0], orderedEvidence.at(-1)!];
  return buildCoverageGapFactFromSummary({
    coveredThroughRevision: input.coveredThroughRevision,
    summary: {
      revision: input.revision,
      eventCount: input.rows.length,
      firstEventId: Math.min(...input.rows.map((row) => row.id)),
      lastEventId: Math.max(...input.rows.map((row) => row.id)),
      sourceSha256: digest,
      evidence,
    },
  });
}

export function buildCoverageGapFactFromSummary(input: {
  coveredThroughRevision: number;
  summary: CoverageGapSourceSummary;
}): ContinuationFact | null {
  const { summary } = input;
  if (
    summary.eventCount < 1 ||
    summary.evidence.length < 1 ||
    input.coveredThroughRevision >= summary.revision
  ) {
    return null;
  }
  return {
    id:
      `${COVERAGE_GAP_FACT_ID_PREFIX}after${input.coveredThroughRevision}.` +
      `r${summary.revision}.${summary.sourceSha256.slice(0, 16)}`,
    status: 'blocked',
    text:
      `Full semantic coverage stops after revision ${input.coveredThroughRevision}; ` +
      `revision ${summary.revision} is represented only by bounded digest ` +
      `sha256:${summary.sourceSha256}; ${summary.eventCount} source event(s), ` +
      `event IDs ${summary.firstEventId}-${summary.lastEventId}.`,
    rationale:
      'The complete revision group could not share the generator fold budget with all required active checkpoint facts.',
    validation:
      `Continuation coverage remains incomplete from revision ${summary.revision}; consult the persisted source events before relying on omitted assistant or tool state.`,
    priority: 100,
    evidence: summary.evidence,
  };
}

/** Reserved markers are app-owned durable facts; provider output cannot add or mutate them. */
export function assertCoverageGapFactsImmutable(input: {
  previous: ContinuationCheckpoint | null;
  next: ContinuationCheckpoint;
}): void {
  const previous = new Map<string, ContinuationFact>();
  if (input.previous) {
    for (const section of CONTINUATION_CHECKPOINT_SECTIONS) {
      for (const fact of input.previous[section]) {
        if (isCoverageGapFact(fact)) previous.set(fact.id, fact);
      }
    }
  }
  const next = new Map<string, ContinuationFact>();
  for (const section of CONTINUATION_CHECKPOINT_SECTIONS) {
    for (const fact of input.next[section]) {
      if (!isCoverageGapFact(fact)) continue;
      if (section !== 'unresolvedErrors' || fact.status !== 'blocked') {
        throw new Error(`Coverage-gap marker ${fact.id} must remain blocked in unresolvedErrors`);
      }
      const prior = previous.get(fact.id);
      if (!prior) throw new Error(`Provider output introduced reserved coverage-gap marker ${fact.id}`);
      if (JSON.stringify(fact) !== JSON.stringify(prior)) {
        throw new Error(`Coverage-gap marker ${fact.id} was rewritten`);
      }
      next.set(fact.id, fact);
    }
  }
  for (const id of previous.keys()) {
    if (!next.has(id)) throw new Error(`Coverage-gap marker ${id} was removed`);
  }
}

/** A persisted marker keeps the preparation degraded even after its revision cursor advances. */
export function coverageGapRangeFromCheckpoint(
  checkpoint: ContinuationCheckpoint | null,
): { from: number; to: number } | null {
  if (!checkpoint) return null;
  let earliestBoundary: number | null = null;
  let latestDigestRevision: number | null = null;
  for (const fact of checkpoint.unresolvedErrors) {
    if (!isCoverageGapFact(fact) || fact.status !== 'blocked') continue;
    const parsed = COVERAGE_GAP_FACT_ID.exec(fact.id);
    const boundary = parsed
      ? Number(parsed[1])
      : Math.max(0, Math.min(...fact.evidence.map((evidence) => evidence.revision)) - 1);
    const digestRevision = parsed
      ? Number(parsed[2])
      : Math.max(...fact.evidence.map((evidence) => evidence.revision));
    earliestBoundary =
      earliestBoundary === null ? boundary : Math.min(earliestBoundary, boundary);
    latestDigestRevision =
      latestDigestRevision === null
        ? digestRevision
        : Math.max(latestDigestRevision, digestRevision);
  }
  return earliestBoundary === null || latestDigestRevision === null
    ? null
    : { from: earliestBoundary, to: latestDigestRevision };
}

export function unionUncoveredRevisionRanges(
  left: { from: number; to: number } | null,
  right: { from: number; to: number } | null,
): { from: number; to: number } | null {
  if (!left) return right;
  if (!right) return left;
  return { from: Math.min(left.from, right.from), to: Math.max(left.to, right.to) };
}
