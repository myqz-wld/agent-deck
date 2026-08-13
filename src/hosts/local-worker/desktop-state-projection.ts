import {
  lstatSync,
  readFileSync,
  realpathSync,
} from 'node:fs';
import { join } from 'node:path';

import { isJsonObject, type JsonObject } from '@contracts/index';
import {
  canonicalProviderDirectory,
  removeProviderFile,
  writeProviderFile,
  type ProviderProjectionMode,
} from '@hosts/provider-state/provider-home-files';
import {
  LOCAL_WORKER_DESKTOP_STATE_PATH,
  LOCAL_WORKER_SYNCED_PROVIDER_SETTING_KEYS,
} from '@hosts/provider-state/local-worker-desktop-state';
import { DEFAULT_SETTINGS } from '@shared/types';

import { resolveServerCoreProviderSettings } from '../server-core/provider-settings';
import { resolveServerCoreSessionLifecycleSettings } from '../server-core/session-lifecycle-options';

const DESKTOP_SETTINGS_FILE = 'agent-deck-settings.json';
const MAX_DESKTOP_SETTINGS_BYTES = 2 * 1024 * 1024;

function desktopUserDataRoot(sourceHome: string): string {
  return join(sourceHome, 'Library', 'Application Support', 'Agent Deck');
}

function readDesktopSettings(sourceHome: string): JsonObject | null {
  const requestedRoot = desktopUserDataRoot(sourceHome);
  const rootStat = lstatSync(requestedRoot, { throwIfNoEntry: false });
  if (!rootStat) return null;
  const root = canonicalProviderDirectory(requestedRoot, 'desktop user data', true);
  const path = join(root, DESKTOP_SETTINGS_FILE);
  const stat = lstatSync(path, { throwIfNoEntry: false });
  if (!stat) return null;
  const uid = typeof process.getuid === 'function' ? process.getuid() : null;
  if (
    !stat.isFile() || stat.isSymbolicLink() || realpathSync(path) !== path ||
    stat.size > MAX_DESKTOP_SETTINGS_BYTES || (uid !== null && stat.uid !== uid)
  ) throw new Error('desktop settings file trust check failed');
  const value = JSON.parse(readFileSync(path, 'utf8')) as unknown;
  if (!isJsonObject(value)) throw new Error('desktop settings must be a JSON object');
  return value;
}

function buildProjection(settings: JsonObject): JsonObject {
  const providerInput = Object.fromEntries(
    LOCAL_WORKER_SYNCED_PROVIDER_SETTING_KEYS.map((key) => [
      key,
      settings[key] ?? DEFAULT_SETTINGS[key],
    ]),
  ) as JsonObject;
  const providerSettings = resolveServerCoreProviderSettings({
    providerSettings: providerInput,
  });
  const sessionLifecycle = resolveServerCoreSessionLifecycleSettings({
    sessionLifecycle: {
      schemaVersion: 1,
      activeWindowMs: settings.activeWindowMs ?? DEFAULT_SETTINGS.activeWindowMs,
      closeAfterMs: settings.closeAfterMs ?? DEFAULT_SETTINGS.closeAfterMs,
      historyRetentionDays:
        settings.historyRetentionDays ?? DEFAULT_SETTINGS.historyRetentionDays,
    },
  });
  return {
    schemaVersion: 1,
    providerSettings: Object.fromEntries(
      LOCAL_WORKER_SYNCED_PROVIDER_SETTING_KEYS.map((key) => [key, providerSettings[key]]),
    ) as JsonObject,
    sessionLifecycle: { schemaVersion: 1, ...sessionLifecycle },
  };
}

/** Copies only allowlisted, non-secret desktop settings into the Worker's private home. */
export function projectLocalWorkerDesktopState(
  sourceHome: string,
  destinationHome: string,
  mode: ProviderProjectionMode,
): readonly string[] {
  canonicalProviderDirectory(sourceHome, 'provider source home', false);
  const destination = canonicalProviderDirectory(
    destinationHome,
    'provider destination home',
    true,
  );
  let settings: JsonObject | null;
  try {
    settings = readDesktopSettings(sourceHome);
  } catch {
    settings = null;
  }
  if (!settings) {
    if (mode === 'replace') removeProviderFile(destination, LOCAL_WORKER_DESKTOP_STATE_PATH);
    return Object.freeze([]);
  }
  let projection: JsonObject;
  try {
    projection = buildProjection(settings);
  } catch {
    if (mode === 'replace') removeProviderFile(destination, LOCAL_WORKER_DESKTOP_STATE_PATH);
    return Object.freeze([]);
  }
  const bytes = Buffer.from(`${JSON.stringify(projection, null, 2)}\n`, 'utf8');
  try {
    writeProviderFile(destination, LOCAL_WORKER_DESKTOP_STATE_PATH, bytes, mode);
  } finally {
    bytes.fill(0);
  }
  return Object.freeze([LOCAL_WORKER_DESKTOP_STATE_PATH]);
}
