import type { ProviderUsageSnapshot } from '@shared/types';
import type { InternalSession } from './sdk-bridge/types';
import {
  readClaudeBridgeUsageSnapshotCore,
  readClaudeUsageSnapshotInBackgroundCore,
  type ClaudeUsageProbeDeps,
} from './usage-snapshot-core';
import { createDesktopClaudeUsageSnapshotHost } from './usage-snapshot-host';
import type { ClaudeSessionManagerPort } from './session-manager-core';

export type { ClaudeUsageProbeDeps } from './usage-snapshot-core';

export function readClaudeBridgeUsageSnapshot(
  sessions: ReadonlyMap<string, InternalSession>,
  sessionManager: Pick<ClaudeSessionManagerPort, 'expectSdkSession'>,
  readBackground: () => Promise<ProviderUsageSnapshot> = () =>
    readClaudeUsageSnapshotInBackground(sessionManager),
): Promise<ProviderUsageSnapshot> {
  return readClaudeBridgeUsageSnapshotCore(
    sessions,
    createDesktopClaudeUsageSnapshotHost(sessionManager),
    readBackground,
  );
}

export function readClaudeUsageSnapshotInBackground(
  sessionManager: Pick<ClaudeSessionManagerPort, 'expectSdkSession'>,
  deps: ClaudeUsageProbeDeps = {},
): Promise<ProviderUsageSnapshot> {
  return readClaudeUsageSnapshotInBackgroundCore(
    createDesktopClaudeUsageSnapshotHost(sessionManager),
    deps,
  );
}
