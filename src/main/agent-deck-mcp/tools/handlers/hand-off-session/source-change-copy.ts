import type { HandOffSourceCutoverRejectionReason } from '@main/session/hand-off/source-precondition';

export function sourceChangeError(reason: HandOffSourceCutoverRejectionReason): {
  error: string;
  hint: string;
} {
  if (reason === 'late-attachment-invalid') {
    return {
      error: 'source session received a late attachment that cannot be replayed safely',
      hint:
        'No successor was created and no resources moved. Prepare a fresh handoff so the attachment is included in the trusted continuation turn.',
    };
  }
  return {
    error: 'source session changed while preparing continuation context',
    hint: 'No successor was created and no resources moved. Prepare a fresh handoff from the current source state.',
  };
}
