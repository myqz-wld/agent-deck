import type { AdapterCapabilities } from '@main/adapters/types';
import {
  firstUnsupportedTargetRuntimeField,
  targetRuntimeFieldAdapters,
  unsupportedTargetRuntimeFieldMessage,
} from '@main/adapters/runtime-control-contracts';
import {
  type SessionRecord,
} from '@shared/types';
import { isSessionPermissionMode, storedSessionPermissionMode } from '@shared/permission-modes';

import type { SpawnSessionArgs } from '../schemas';
import { defaultPermissionModeForTargetAdapter } from './spawn-defaults';

interface RuntimeControlError {
  error: string;
  hint: string;
}

export function validateSpawnRuntimeControls(
  args: SpawnSessionArgs,
): RuntimeControlError | null {
  if (args.permissionMode !== undefined && !isSessionPermissionMode(args.permissionMode)) {
    return { error: 'permissionMode must be auto or bypassPermissions',
      hint: 'Select auto for native automatic approval or bypassPermissions for no routine prompts.' };
  }
  const unsupported = firstUnsupportedTargetRuntimeField(args.adapter, args);
  if (unsupported === null) return null;
  const owners = targetRuntimeFieldAdapters(unsupported).join(' or ');
  if (unsupported === 'sessionMode') {
    return {
      error: unsupportedTargetRuntimeFieldMessage(args.adapter, unsupported),
      hint: 'Remove sessionMode or choose grok-build. Common permission presets are selected with permissionMode.',
    };
  }
  if (
    unsupported === 'codexSandbox' ||
    unsupported === 'claudeCodeSandbox' ||
    unsupported === 'grokSandbox' ||
    unsupported === 'extraAllowWrite'
  ) {
    return {
      error: unsupportedTargetRuntimeFieldMessage(args.adapter, unsupported),
      hint: `Remove ${unsupported} or choose ${owners}. Each adapter owns a distinct sandbox control; Grok permissions remain ACP-native and separate from grokSandbox.`,
    };
  }
  return {
    error: unsupportedTargetRuntimeFieldMessage(args.adapter, unsupported),
    hint: `Remove ${unsupported} or choose ${owners}.`,
  };
}

export function resolveSpawnRuntimeControls(input: {
  args: SpawnSessionArgs;
  capabilities: AdapterCapabilities;
  leadRecord: SessionRecord | null;
  inherit: boolean;
  codexSandboxFromAgent: SpawnSessionArgs['codexSandbox'] | undefined;
}) {
  const { args, capabilities, leadRecord, inherit } = input;
  const inheritedPermission = inherit && leadRecord && isSessionPermissionMode(leadRecord.permissionMode)
    ? storedSessionPermissionMode(leadRecord) : null;
  return {
    effectivePermissionMode: capabilities.canSetPermissionMode
      ? args.permissionMode ??
        (inherit
          ? inheritedPermission ?? (args.adapter !== 'codex-cli' && leadRecord?.permissionMode
              ? 'auto' : defaultPermissionModeForTargetAdapter(args.adapter))
          : defaultPermissionModeForTargetAdapter(args.adapter))
      : undefined,
    effectiveSessionMode: capabilities.canSetSessionMode
      ? args.sessionMode ??
        (inherit ? (leadRecord?.sessionMode ?? undefined) : undefined)
      : undefined,
    effectiveCodexSandbox:
      args.codexSandbox ??
      input.codexSandboxFromAgent ??
      (inherit ? (leadRecord?.codexSandbox ?? undefined) : undefined),
    effectiveClaudeCodeSandbox:
      args.claudeCodeSandbox ??
      (inherit ? (leadRecord?.claudeCodeSandbox ?? undefined) : undefined),
    effectiveGrokSandbox:
      args.grokSandbox !== undefined
        ? args.grokSandbox
        : inherit && leadRecord?.agentId === 'grok-build'
          ? leadRecord.grokSandbox ?? null
          : undefined,
    effectiveExtraAllowWrite:
      args.extraAllowWrite !== undefined
        ? args.extraAllowWrite
        : inherit
          ? (leadRecord?.extraAllowWrite ?? undefined)
          : undefined,
  };
}
