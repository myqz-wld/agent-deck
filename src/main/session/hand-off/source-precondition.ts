import type { SessionRecord, UploadedAttachmentRef } from '@shared/types';
import { classifyContinuationMessage } from '../continuation-context/message-classifier';
import {
  eventRevisionRepo,
  type EventRevisionRepo,
} from '@main/store/event-revision-repo';
import { sessionRepo } from '@main/store/session-repo';
import { continuationSessionRuntimeFingerprint } from '../continuation-context/source-spool';
import { getDb } from '@main/store/db';

const SOURCE_CHANGE_PAGE_SIZE = 1_000;
const SOURCE_CHANGE_STABILITY_ATTEMPTS = 3;
const CAPTURED_TELEMETRY_KINDS = new Set(['tool-use-start', 'tool-use-end']);

export interface HandOffSourceCutoverPrecondition {
  eventRevision: number;
  rebuildAfterRevision: number;
  maxEventId: number | null;
  runtimeFingerprint: string;
}

export interface HandOffSourceCutoverCheck {
  sourceSessionId: string;
  expected: HandOffSourceCutoverPrecondition;
}

export interface HandOffLateMessage {
  eventId: number;
  text: string;
  attachments: UploadedAttachmentRef[];
  origin: 'user' | 'cross-session' | 'legacy-unwrapped';
}

export type HandOffSourceCutoverRejectionReason =
  | 'source-not-open'
  | 'runtime-changed'
  | 'revision-state-missing'
  | 'revision-regressed'
  | 'rebuild-epoch-changed'
  | 'captured-event-mutated'
  | 'late-attachment-invalid'
  | 'revision-gap'
  | 'source-kept-changing'
  | 'late-message-delivery-failed'
  | 'check-failed';

export type HandOffSourceCutoverResult =
  | {
      ok: true;
      currentEventRevision: number;
      compatibleEventRows: number;
      lateMessages: HandOffLateMessage[];
    }
  | {
      ok: false;
      reason: HandOffSourceCutoverRejectionReason;
      currentEventRevision: number | null;
    };

export interface HandOffSourcePreconditionDeps {
  getSession: (sessionId: string) => SessionRecord | null;
  runtimeFingerprint: (sessionId: string) => string | null;
  eventReader: EventRevisionRepo;
}

function rejected(
  reason: HandOffSourceCutoverRejectionReason,
  currentEventRevision: number | null,
): HandOffSourceCutoverResult {
  return { ok: false, reason, currentEventRevision };
}

function parseUploadedAttachmentRefs(payloadJson: string): UploadedAttachmentRef[] | null {
  let payload: Record<string, unknown>;
  try {
    const parsed = JSON.parse(payloadJson) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    payload = parsed as Record<string, unknown>;
  } catch {
    return null;
  }
  if (payload.attachments === undefined) return [];
  if (!Array.isArray(payload.attachments)) return null;
  const refs: UploadedAttachmentRef[] = [];
  for (const value of payload.attachments) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    const attachment = value as Record<string, unknown>;
    if (
      attachment.kind !== 'uploaded' ||
      typeof attachment.path !== 'string' ||
      typeof attachment.mime !== 'string' ||
      typeof attachment.bytes !== 'number' ||
      !Number.isSafeInteger(attachment.bytes) ||
      attachment.bytes < 0
    ) {
      return null;
    }
    refs.push({
      kind: 'uploaded',
      path: attachment.path,
      mime: attachment.mime,
      bytes: attachment.bytes,
    });
  }
  return refs;
}

function assessAtRevision(
  input: HandOffSourceCutoverCheck,
  reader: EventRevisionRepo,
  state: NonNullable<ReturnType<EventRevisionRepo['state']>>,
): HandOffSourceCutoverResult {
  if (state.revision < input.expected.eventRevision) {
    return rejected('revision-regressed', state.revision);
  }
  if (state.rebuildAfterRevision !== input.expected.rebuildAfterRevision) {
    return rejected('rebuild-epoch-changed', state.revision);
  }
  if (state.revision === input.expected.eventRevision) {
    return {
      ok: true,
      currentEventRevision: state.revision,
      compatibleEventRows: 0,
      lateMessages: [],
    };
  }

  let compatibleEventRows = 0;
  const lateMessages: HandOffLateMessage[] = [];
  let cursor = { revision: input.expected.eventRevision, id: Number.MAX_SAFE_INTEGER };
  for (;;) {
    const rows = reader.listRawEvents({
      sessionId: input.sourceSessionId,
      throughRevision: state.revision,
      after: cursor,
      limit: SOURCE_CHANGE_PAGE_SIZE,
    });
    if (rows.length === 0) break;
    for (const row of rows) {
      const capturedRow =
        input.expected.maxEventId !== null && row.id <= input.expected.maxEventId;
      const compatibleCapturedTelemetryUpdate =
        capturedRow &&
        CAPTURED_TELEMETRY_KINDS.has(row.kind) &&
        typeof row.toolUseId === 'string' &&
        row.toolUseId.length > 0;
      if (capturedRow && !compatibleCapturedTelemetryUpdate) {
        return rejected('captured-event-mutated', state.revision);
      }
      const classification = classifyContinuationMessage({
        eventId: row.id,
        effectiveRevision: row.effectiveRevision,
        ts: row.ts,
        kind: row.kind,
        payloadJson: row.payloadJson,
      });
      if (classification.message) {
        const attachments = parseUploadedAttachmentRefs(row.payloadJson);
        if (!attachments) return rejected('late-attachment-invalid', state.revision);
        lateMessages.push({
          eventId: classification.message.eventId,
          text: classification.message.text,
          attachments,
          origin: classification.message.origin,
        });
      }
      compatibleEventRows += 1;
    }
    const last = rows.at(-1)!;
    cursor = { revision: last.effectiveRevision, id: last.id };
    if (rows.length < SOURCE_CHANGE_PAGE_SIZE) break;
  }

  if (compatibleEventRows === 0) return rejected('revision-gap', state.revision);
  return {
    ok: true,
    currentEventRevision: state.revision,
    compatibleEventRows,
    lateMessages,
  };
}

/**
 * Validate the immutable capture without requiring it to remain the latest source revision.
 * Rows created after maxEventId are append-only activity. User/cross-session inputs are retained as
 * a late tail for mandatory successor delivery; destructive history/runtime changes still reject.
 */
export function assessHandOffSourceEvents(
  input: HandOffSourceCutoverCheck,
  reader: EventRevisionRepo = eventRevisionRepo,
): HandOffSourceCutoverResult {
  let lastRevision: number | null = null;
  for (let attempt = 0; attempt < SOURCE_CHANGE_STABILITY_ATTEMPTS; attempt += 1) {
    const state = reader.state(input.sourceSessionId);
    if (!state) return rejected('revision-state-missing', null);
    lastRevision = state.revision;
    const result = assessAtRevision(input, reader, state);
    const after = reader.state(input.sourceSessionId);
    if (!after) return rejected('revision-state-missing', null);
    if (after.revision < state.revision) return rejected('revision-regressed', after.revision);
    if (
      after.revision === state.revision &&
      after.rebuildAfterRevision === state.rebuildAfterRevision
    ) {
      return result;
    }
    lastRevision = after.revision;
  }
  return rejected('source-kept-changing', lastRevision);
}

function productionDeps(): HandOffSourcePreconditionDeps {
  return {
    getSession: (sessionId) => sessionRepo.get(sessionId),
    runtimeFingerprint: (sessionId) =>
      continuationSessionRuntimeFingerprint(getDb(), sessionId),
    eventReader: eventRevisionRepo,
  };
}

export function checkHandOffSourcePrecondition(
  input: HandOffSourceCutoverCheck,
  deps: HandOffSourcePreconditionDeps = productionDeps(),
): HandOffSourceCutoverResult {
  try {
    const sourceBefore = deps.getSession(input.sourceSessionId);
    if (!sourceBefore || sourceBefore.lifecycle === 'closed' || sourceBefore.archivedAt !== null) {
      return rejected('source-not-open', null);
    }
    if (deps.runtimeFingerprint(input.sourceSessionId) !== input.expected.runtimeFingerprint) {
      return rejected('runtime-changed', null);
    }
    const result = assessHandOffSourceEvents(input, deps.eventReader);
    if (!result.ok) return result;
    const sourceAfter = deps.getSession(input.sourceSessionId);
    if (!sourceAfter || sourceAfter.lifecycle === 'closed' || sourceAfter.archivedAt !== null) {
      return rejected('source-not-open', result.currentEventRevision);
    }
    if (deps.runtimeFingerprint(input.sourceSessionId) !== input.expected.runtimeFingerprint) {
      return rejected('runtime-changed', result.currentEventRevision);
    }
    return result;
  } catch {
    return rejected('check-failed', null);
  }
}
