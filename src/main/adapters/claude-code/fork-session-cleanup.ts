import {
  createClaudeForkCleanupCore,
  type ClaudeForkCleanupInput,
} from './fork-session-cleanup-core';
import { desktopClaudeForkCleanupObserver } from './fork-session-cleanup-host';

export {
  ClaudeForkDiscardError,
  type ClaudeForkChildStore,
  type ClaudeForkCleanupIssue,
  type ClaudeForkCleanupSdk,
} from './fork-session-cleanup-core';

export function createClaudeForkCleanup(input: ClaudeForkCleanupInput): () => Promise<void> {
  return createClaudeForkCleanupCore(input, desktopClaudeForkCleanupObserver);
}
