import { homedir } from 'node:os';
import { resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import { resolveSessionCreationDefaults } from '@main/adapters/session-creation-defaults';
import { isSessionAdapterId } from '@main/adapters/runtime-profiles';
import log from '@main/utils/logger';
import { IpcInvoke } from '@shared/ipc-channels';
import { IpcInputError, on, parseStringId } from './_helpers';

const logger = log.scope('adapter-session-creation-defaults');
export const SESSION_CREATION_DEFAULTS_SLOW_MS = 150;

export function registerAdapterSessionCreationDefaultsIpc(): void {
  on(IpcInvoke.AdapterSessionCreationDefaults, async (_event, adapterId, rawOptions) => {
    const parsedAdapterId = parseStringId('adapterId', adapterId, 64);
    if (!isSessionAdapterId(parsedAdapterId)) {
      throw new IpcInputError('adapterId', 'unknown adapter');
    }
    if (
      rawOptions !== undefined &&
      (rawOptions === null || typeof rawOptions !== 'object' || Array.isArray(rawOptions))
    ) {
      throw new IpcInputError('options', 'must be object');
    }
    const options = (rawOptions ?? {}) as Record<string, unknown>;
    const cwd = optionalTrimmedString('options.cwd', options.cwd, 4096);
    const provider = optionalTrimmedString('options.provider', options.provider, 256);
    const startedAt = performance.now();
    let outcome: 'success' | 'error' = 'success';
    try {
      return await resolveSessionCreationDefaults(parsedAdapterId, {
        cwd: resolve(cwd || homedir()),
        ...(provider ? { provider } : {}),
      });
    } catch (error) {
      outcome = 'error';
      throw error;
    } finally {
      const durationMs = elapsedMs(startedAt);
      if (durationMs >= SESSION_CREATION_DEFAULTS_SLOW_MS) {
        try {
          logger.warn('[adapter-session-creation-defaults] resolution slow', {
            event: 'adapter_session_creation_defaults',
            adapterId: parsedAdapterId,
            outcome,
            durationMs,
            slowThresholdMs: SESSION_CREATION_DEFAULTS_SLOW_MS,
          });
        } catch {
          // Diagnostics cannot change IPC results or fallback behavior.
        }
      }
    }
  });
}

function elapsedMs(startedAt: number): number {
  const elapsed = performance.now() - startedAt;
  if (!Number.isFinite(elapsed)) return 0;
  return Math.max(0, Math.round(elapsed));
}

function optionalTrimmedString(
  field: string,
  value: unknown,
  maxLength: number,
): string {
  if (value === undefined || value === null) return '';
  if (typeof value !== 'string') {
    throw new IpcInputError(field, 'must be string');
  }
  const trimmed = value.trim();
  if (trimmed.length > maxLength) {
    throw new IpcInputError(field, `length > ${maxLength}`);
  }
  return trimmed;
}
