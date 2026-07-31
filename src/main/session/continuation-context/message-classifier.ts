import { parseWirePrefix } from '@shared/wire-prefix';

const CURRENT_CONTEXT_PREFIX = '===== Agent Deck Continuation Context v';

export interface ContinuationMessageCandidate {
  eventId: number;
  effectiveRevision: number;
  ts: number;
  kind: string;
  payloadJson: string;
}

export interface ClassifiedContinuationMessage {
  eventId: number;
  effectiveRevision: number;
  ts: number;
  text: string;
  attachments: Array<{ path?: string; mimeType?: string; name?: string }>;
  origin: 'user' | 'cross-session';
}

export interface ContinuationMessageClassification {
  message: ClassifiedContinuationMessage | null;
  warning?: 'context-wrapper-excluded';
}

function extractAttachments(payload: Record<string, unknown>): ClassifiedContinuationMessage['attachments'] {
  if (!Array.isArray(payload.attachments)) return [];
  return payload.attachments.flatMap((value) => {
    if (!value || typeof value !== 'object') return [];
    const attachment = value as Record<string, unknown>;
    const path = typeof attachment.path === 'string' ? attachment.path : undefined;
    const mimeType =
      typeof attachment.mime === 'string'
        ? attachment.mime
        : typeof attachment.mimeType === 'string'
          ? attachment.mimeType
          : undefined;
    const name = typeof attachment.name === 'string' ? attachment.name : undefined;
    return path || mimeType || name ? [{ path, mimeType, name }] : [];
  });
}

/** Classify one persisted event without allowing a derived context wrapper to recurse. */
export function classifyContinuationMessage(
  candidate: ContinuationMessageCandidate,
): ContinuationMessageClassification {
  if (candidate.kind !== 'message') return { message: null };
  let payload: Record<string, unknown>;
  try {
    const parsed = JSON.parse(candidate.payloadJson) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return { message: null };
    payload = parsed as Record<string, unknown>;
  } catch {
    return { message: null };
  }
  if (payload.role !== 'user' || payload.error === true || payload.synthetic === true) {
    return { message: null };
  }
  const attachments = extractAttachments(payload);
  const rawText = typeof payload.text === 'string' ? payload.text : '';
  const normalizedText = rawText.trim();
  if (!normalizedText && attachments.length === 0) return { message: null };

  if (normalizedText.startsWith(CURRENT_CONTEXT_PREFIX)) {
    return { message: null, warning: 'context-wrapper-excluded' };
  }

  const wire = parseWirePrefix(rawText);
  if (wire && !wire.body.trim()) return { message: null };
  return {
    message: {
      eventId: candidate.eventId,
      effectiveRevision: candidate.effectiveRevision,
      ts: candidate.ts,
      text: rawText,
      attachments,
      origin: wire ? 'cross-session' : 'user',
    },
  };
}
