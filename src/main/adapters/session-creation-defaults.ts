import type { SessionAdapterId, SessionCreationDefaults } from '@shared/types';
import { settingsStore } from '@main/store/settings-store';
import log from '@main/utils/logger';
import { getCodexInstance } from './codex-cli/codex-instance-pool';
import {
  resolveSessionCreationDefaultsCore,
  type SessionCreationConfigRecord,
  type SessionCreationCoreDeps,
  type SessionCreationResolveOptions,
  type SessionCreationSettings,
} from './session-creation-defaults-core';
import type {
  SessionConfigDiagnostic,
  SessionConfigReadObservation,
} from './session-creation-config-reader';
import { desktopSessionCreationDefaultsHost } from './session-creation-defaults-host';

export {
  CODEX_CREATION_DEFAULTS_TIMEOUT_MS,
  type SessionCreationConfigRecord,
  type SessionCreationResolveOptions,
  type SessionCreationSettings,
} from './session-creation-defaults-core';

export type SessionCreationResolveDeps = Omit<
  SessionCreationCoreDeps,
  'readCodexConfig' | 'settings'
> & {
  readCodexConfig?: SessionCreationCoreDeps['readCodexConfig'];
  settings?: SessionCreationSettings;
};

const logger = log.scope('session-creation-defaults');

/** Desktop composition for the host-neutral session creation defaults resolver. */
export function resolveSessionCreationDefaults(
  adapterId: SessionAdapterId,
  options: SessionCreationResolveOptions,
  deps: SessionCreationResolveDeps = {},
): Promise<SessionCreationDefaults> {
  return resolveSessionCreationDefaultsCore(adapterId, options, {
    ...deps,
    settings: deps.settings ?? settingsStore.getAll(),
    readCodexConfig: deps.readCodexConfig ?? readEffectiveCodexConfig,
    onDiagnostic: deps.onDiagnostic ?? emitDesktopDiagnostic,
    onConfigReadObservation:
      deps.onConfigReadObservation ?? emitDesktopConfigReadObservation,
  }, desktopSessionCreationDefaultsHost);
}

async function readEffectiveCodexConfig(
  cwd: string,
  signal?: AbortSignal,
): Promise<SessionCreationConfigRecord> {
  const client = await getCodexInstance();
  const response = await client.request<{ config?: unknown }>(
    'config/read',
    { includeLayers: false, cwd },
    signal,
  );
  return isRecord(response.config) ? response.config : {};
}

function emitDesktopDiagnostic(diagnostic: SessionConfigDiagnostic): void {
  try {
    const message = '[session-creation-defaults] config fallback';
    if (diagnostic.failureCategory === 'not-found') {
      logger.debug(message, diagnostic);
    } else {
      logger.warn(message, diagnostic);
    }
  } catch {
    // Logging cannot make default resolution fail.
  }
}

function emitDesktopConfigReadObservation(
  observation: SessionConfigReadObservation,
): void {
  if (observation.outcome !== 'success' || observation.durationMs < 150) return;
  try {
    logger.warn('[session-creation-defaults] config read slow', observation);
  } catch {
    // Timing diagnostics cannot make default resolution fail.
  }
}

function isRecord(value: unknown): value is SessionCreationConfigRecord {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}
