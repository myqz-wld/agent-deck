export type CallerArchiveFailureReasonKind =
  | 'row-missing'
  | 'probe-throw'
  | 'archive-throw';

export interface CallerArchiveFailedEvent {
  sessionId: string;
  toolName: 'hand_off_session' | 'SessionHandOffCommit';
  reason: string;
  reasonKind: CallerArchiveFailureReasonKind;
}

export const MAX_CALLER_ARCHIVE_FAILURE_REASON_LENGTH = 2_000;
