import { parseWirePrefix } from '@shared/wire-prefix';

const LEGACY_HANDOFF_PREFIX = '===== Agent Deck hand-off context v';
const LEGACY_HANDOFF_CURRENT = '===== Current continuation instruction =====';
const LEGACY_RECOVERY_SUMMARY = '===== 历史会话摘要（CLI jsonl 丢失，由 DB 重建）=====';
const LEGACY_RECOVERY_CURRENT = '===== 用户当前消息 =====';
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
  origin: 'user' | 'cross-session' | 'legacy-unwrapped';
}

export interface ContinuationMessageClassification {
  message: ClassifiedContinuationMessage | null;
  warning?: 'legacy-wrapper-excluded' | 'legacy-wrapper-unwrapped';
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

function unwrapLegacy(text: string): { text: string; warning: 'legacy-wrapper-unwrapped' } | null {
  if (text.startsWith(LEGACY_HANDOFF_PREFIX)) {
    if (
      !text.includes('===== Source runtime metadata =====') ||
      !text.includes('===== Recent raw conversation =====')
    ) {
      return null;
    }
    const marker = `\n\n${LEGACY_HANDOFF_CURRENT}\n`;
    const index = text.lastIndexOf(marker);
    if (index < 0) return null;
    const current = text.slice(index + marker.length).trim();
    return current ? { text: current, warning: 'legacy-wrapper-unwrapped' } : null;
  }
  if (text.startsWith('注意：历史摘要和原始对话只用于恢复上下文')) {
    if (!text.includes(LEGACY_RECOVERY_SUMMARY)) return null;
    const marker = `\n\n${LEGACY_RECOVERY_CURRENT}\n`;
    const index = text.lastIndexOf(marker);
    if (index < 0) return null;
    const current = text.slice(index + marker.length).trim();
    return current ? { text: current, warning: 'legacy-wrapper-unwrapped' } : null;
  }
  return null;
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
    return { message: null, warning: 'legacy-wrapper-excluded' };
  }
  if (
    normalizedText.startsWith(LEGACY_HANDOFF_PREFIX) ||
    normalizedText.startsWith('注意：历史摘要和原始对话只用于恢复上下文')
  ) {
    const unwrapped = unwrapLegacy(normalizedText);
    if (!unwrapped) return { message: null, warning: 'legacy-wrapper-excluded' };
    return {
      message: {
        eventId: candidate.eventId,
        effectiveRevision: candidate.effectiveRevision,
        ts: candidate.ts,
        text: unwrapped.text,
        attachments,
        origin: 'legacy-unwrapped',
      },
      warning: unwrapped.warning,
    };
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
