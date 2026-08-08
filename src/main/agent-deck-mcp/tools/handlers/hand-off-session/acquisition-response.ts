import type { HandOffCutoverAcquireResult } from '@main/session/hand-off/cutover-coordinator';
import { err, type HandlerResult } from '../../helpers';

type RejectedAcquisition = Extract<HandOffCutoverAcquireResult, { ok: false }>;

export function handOffAcquisitionError(
  sourceSessionId: string,
  acquisition: RejectedAcquisition,
): HandlerResult {
  if (acquisition.reason === 'active') {
    return err(
      `handoff already in progress for source session: ${sourceSessionId}`,
      'Wait for the current handoff attempt to finish. No continuation generation or successor creation occurred for this request.',
    );
  }
  if (acquisition.reason === 'committed') {
    return err(
      `source session already handed off to: ${acquisition.successorSessionId}`,
      'Continue in the committed successor, or explicitly reactivate the source before starting a new owner epoch.',
    );
  }
  if (acquisition.reason === 'sealed') {
    return err(
      `source session is sealed against another handoff: ${sourceSessionId}`,
      'Reopen and explicitly reactivate the source before starting a new owner epoch.',
    );
  }
  return err(
    `failed to verify prior handoff ownership for source session: ${sourceSessionId}`,
    'The durable handoff alias store could not be read, so acquisition failed closed. Check the session database and retry.',
  );
}
