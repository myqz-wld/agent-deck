import { getProviderUsageProbeCwd } from '@main/paths';
import { settingsStore } from '@main/store/settings-store';
import { createDesktopCodexAppServerClient } from './app-server/client-diagnostics';
import type { CodexUsageSnapshotHost } from './usage-snapshot-core';

function snapshotProcessEnv(): Record<string, string> {
  const snapshot: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined) snapshot[key] = value;
  }
  return snapshot;
}

export const desktopCodexUsageSnapshotHost: CodexUsageSnapshotHost = {
  createClient: (options) => createDesktopCodexAppServerClient(options),
  readCodexCliPath: () => settingsStore.get('codexCliPath'),
  readProbeCwd: () => getProviderUsageProbeCwd(),
  snapshotProcessEnv,
};
