import {
  firstUnsupportedTargetRuntimeField,
  unsupportedTargetRuntimeFieldMessage,
} from '@main/adapters/runtime-control-contracts';
import type { SessionAdapterId } from '@shared/types';

import {
  IpcInputError,
  parseAdapterSessionMode,
  parseCodexSandboxMode,
  parseOptionalAbsolutePathArray,
  parsePermissionMode,
  parseSandboxMode,
} from './_helpers';

/**
 * Parse the flat IPC payload, then enforce the selected provider's owned runtime fields.
 * Returning all controls together keeps creation from silently filtering a foreign option.
 */
export function parseAdapterCreateRuntimeControls(
  adapterId: SessionAdapterId,
  raw: Record<string, unknown>,
) {
  const permissionMode = parsePermissionMode(raw.permissionMode);
  const sessionMode = parseAdapterSessionMode(raw.sessionMode);
  const codexSandbox = parseCodexSandboxMode(raw.codexSandbox);
  const claudeCodeSandbox = parseSandboxMode(raw.claudeCodeSandbox);
  const extraAllowWrite = parseOptionalAbsolutePathArray(
    'opts.extraAllowWrite',
    raw.extraAllowWrite,
  );
  const controls = {
    ...(permissionMode !== null ? { permissionMode } : {}),
    ...(sessionMode !== null ? { sessionMode } : {}),
    ...(codexSandbox !== null ? { codexSandbox } : {}),
    ...(claudeCodeSandbox !== null ? { claudeCodeSandbox } : {}),
    ...(extraAllowWrite !== null ? { extraAllowWrite } : {}),
  };
  const unsupported = firstUnsupportedTargetRuntimeField(adapterId, controls);
  if (unsupported !== null) {
    throw new IpcInputError(
      `opts.${unsupported}`,
      unsupportedTargetRuntimeFieldMessage(adapterId, unsupported),
    );
  }
  return {
    permissionMode,
    sessionMode,
    codexSandbox,
    claudeCodeSandbox,
    extraAllowWrite,
  };
}
