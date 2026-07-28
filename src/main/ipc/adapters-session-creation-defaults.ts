import { homedir } from 'node:os';
import { resolve } from 'node:path';
import { resolveSessionCreationDefaults } from '@main/adapters/session-creation-defaults';
import { isSessionAdapterId } from '@main/adapters/runtime-profiles';
import { IpcInvoke } from '@shared/ipc-channels';
import { IpcInputError, on, parseStringId } from './_helpers';

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
    return resolveSessionCreationDefaults(parsedAdapterId, {
      cwd: resolve(cwd || homedir()),
      ...(provider ? { provider } : {}),
    });
  });
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
