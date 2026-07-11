import { isRecoveryCancelledError } from '@main/adapters/shared/recovery-cancelled';
import type { UploadedAttachmentRef } from '@shared/types';
import type { RecoverAndSendDeps } from './_deps';

/** Forward a message that arrived behind an already-running recovery operation. */
export async function sendAfterInflightRecovery(input: {
  inflight: Promise<unknown>;
  sessionId: string;
  text: string;
  attachments: UploadedAttachmentRef[] | undefined;
  sendThunk: RecoverAndSendDeps['sendThunk'];
}): Promise<string> {
  let finalId: string;
  try {
    finalId = (await input.inflight) as string;
  } catch (error) {
    // A close during recovery is authoritative. Retrying here would revive the session that the
    // user just closed. Other failures retain the existing behavior: retry through the old id so
    // this message can initiate a fresh recovery attempt of its own.
    if (isRecoveryCancelledError(error)) return input.sessionId;
    finalId = input.sessionId;
  }

  await input.sendThunk(finalId, input.text, input.attachments);
  return finalId;
}
