import { settingsStore } from '@main/store/settings-store';
import { createDesktopCodexAppServerClient } from './app-server/client-diagnostics';
import type { CodexInstancePoolHost } from './instance-pool-core';

function snapshotProcessEnv(): Record<string, string> {
  const snapshot: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined) snapshot[key] = value;
  }
  return snapshot;
}

export const desktopCodexInstancePoolHost: CodexInstancePoolHost<
  ReturnType<typeof createDesktopCodexAppServerClient>
> = {
  createClient: (options) => createDesktopCodexAppServerClient(options),
  readCodexCliPath: () => settingsStore.get('codexCliPath'),
  snapshotProcessEnv,
};
