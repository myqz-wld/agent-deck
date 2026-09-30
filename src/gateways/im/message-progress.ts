import type { EnrolledFeishuCredential, FeishuMessageEvent, NotificationEvent, SessionConsoleView } from './types';

/** Transient presentation only. A progress adapter cannot authorize or block business operations. */
export interface FeishuMessageProgressPort {
  begin(event: FeishuMessageEvent, credential: EnrolledFeishuCredential): void;
  accepted(eventId: string, view: SessionConsoleView): void;
  failed(eventId: string, retryable: boolean): void;
  notification(credential: EnrolledFeishuCredential, chatId: string, event: NotificationEvent, pending?: boolean): void;
  resumed(credential: EnrolledFeishuCredential, chatId: string, sessionId: string): void;
  close(): Promise<void>;
}

export interface FeishuProcessingTarget {
  sessionId: string;
  /** Send events start only when the adapter accepts the correlated user turn, not at enqueue. */
  correlationId?: string;
  /** A freshly created session has no older turn; this fences pre-creation Core events. */
  afterRevision?: number;
}

export function notifyFeishuProgress(work: () => void): void {
  try { work(); } catch { /* Optional presentation cannot change the authoritative result. */ }
}
