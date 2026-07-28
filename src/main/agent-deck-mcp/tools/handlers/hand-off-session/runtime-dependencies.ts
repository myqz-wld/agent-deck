import { statSync } from 'node:fs';

import {
  ContinuationSourceSpoolStore,
  continuationSessionRuntimeFingerprint,
} from '@main/session/continuation-context/source-spool';
import { getDb } from '@main/store/db';
import { universalMessageWatcher } from '@main/teams/universal-message-watcher';

export function handOffCwdIsDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

export function cleanupHandOffSpool(spoolId: string): void {
  new ContinuationSourceSpoolStore(getDb()).cleanup(spoolId);
}

export function handOffSpoolMetadata(spoolId: string) {
  return new ContinuationSourceSpoolStore(getDb()).metadata(spoolId);
}

export function handOffSourceRuntimeFingerprint(sessionId: string): string | null {
  return continuationSessionRuntimeFingerprint(getDb(), sessionId);
}

export async function drainHandOffMessageDeliveries(
  sourceSessionId: string,
): Promise<boolean> {
  return (await universalMessageWatcher.drainForHandOff(sourceSessionId)).drained;
}
