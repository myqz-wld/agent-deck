import type { AdapterCapabilities } from '@main/adapters/types';
import type { SessionRecord } from '@shared/types';

import type { SpawnSessionArgs } from '../schemas';
import { defaultPermissionModeForTargetAdapter } from './spawn-defaults';

interface RuntimeControlError {
  error: string;
  hint: string;
}

export function validateSpawnRuntimeControls(
  args: SpawnSessionArgs,
  capabilities: AdapterCapabilities,
): RuntimeControlError | null {
  if (args.permissionMode !== undefined && !capabilities.canSetPermissionMode) {
    return {
      error: `permissionMode is incompatible with adapter "${args.adapter}"`,
      hint:
        args.adapter === 'grok-build'
          ? 'Remove permissionMode. Grok ACP work modes (default, plan, ask) are distinct from Claude permission modes.'
          : 'Remove permissionMode or choose claude-code / deepseek-claude-code.',
    };
  }
  if (args.sessionMode !== undefined && !capabilities.canSetSessionMode) {
    return {
      error: `sessionMode is incompatible with adapter "${args.adapter}"`,
      hint: 'Remove sessionMode or choose grok-build. Grok work modes are distinct from Claude permission modes.',
    };
  }
  if (
    args.adapter === 'grok-build' &&
    (args.codexSandbox !== undefined ||
      args.claudeCodeSandbox !== undefined ||
      (args.extraAllowWrite?.length ?? 0) > 0)
  ) {
    return {
      error: 'Claude/Codex sandbox controls are incompatible with adapter "grok-build"',
      hint: 'Remove codexSandbox, claudeCodeSandbox, and extraAllowWrite. Grok Build keeps its native tool and permission policy.',
    };
  }
  return null;
}

export function resolveSpawnRuntimeControls(input: {
  args: SpawnSessionArgs;
  capabilities: AdapterCapabilities;
  leadRecord: SessionRecord | null;
  inherit: boolean;
  codexSandboxFromAgent: SpawnSessionArgs['codexSandbox'] | undefined;
}) {
  const { args, capabilities, leadRecord, inherit } = input;
  return {
    effectivePermissionMode: capabilities.canSetPermissionMode
      ? args.permissionMode ??
        (inherit
          ? (leadRecord?.permissionMode ?? undefined)
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
    effectiveExtraAllowWrite:
      args.extraAllowWrite !== undefined
        ? args.extraAllowWrite
        : inherit
          ? (leadRecord?.extraAllowWrite ?? undefined)
          : undefined,
  };
}
