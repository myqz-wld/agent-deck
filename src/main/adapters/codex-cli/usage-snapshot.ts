import type { ProviderUsageSnapshot } from '@shared/types';
import {
  readCodexUsageSnapshotWithHost,
  type CodexUsageProbeDeps,
} from './usage-snapshot-core';
import { desktopCodexUsageSnapshotHost } from './usage-snapshot-host';

export {
  codexUsageUnavailableSnapshot,
  isExpectedCodexUsageUnavailable,
} from './usage-probe-store';
export { invalidateCodexUsageSnapshotClient } from './usage-snapshot-core';
export type { CodexUsageProbeDeps } from './usage-snapshot-core';

/**
 * Read Codex account rate limits without creating a Codex thread or turn.
 *
 * This sends only `account/rateLimits/read`; it must not call
 * startThread/resumeThread/run. Production reads reuse a short-lived app-server
 * client because the Codex quota endpoint is unstable when every refresh
 * recreates the process.
 */
export async function readCodexUsageSnapshotInBackground(
  deps: CodexUsageProbeDeps = {},
): Promise<ProviderUsageSnapshot> {
  return readCodexUsageSnapshotWithHost(desktopCodexUsageSnapshotHost, deps);
}
