import {
  firstUnsupportedTargetRuntimeField,
  unsupportedTargetRuntimeFieldMessage,
} from '@main/adapters/runtime-control-contracts';
import { adapterRegistry } from '@main/adapters/registry';
import { getAdapterRuntimeProfile } from '@main/adapters/runtime-profiles';
import { IpcInvoke } from '@shared/ipc-channels';
import { SDK_RESTART_RESUME_PROMPT } from '@shared/restart-prompts';
import type { SessionAdapterId } from '@shared/types';

import {
  IpcInputError,
  on,
  parseAdapterSessionMode,
  parseCodexApprovalPolicy,
  parseCodexSandboxMode,
  parseGrokSandboxProfile,
  parseOptionalAbsolutePathArray,
  parsePermissionMode,
  parseSandboxMode,
  parseStringId,
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
  const approvalPolicy = parseCodexApprovalPolicy(raw.approvalPolicy);
  const codexSandbox = parseCodexSandboxMode(raw.codexSandbox);
  const claudeCodeSandbox = parseSandboxMode(raw.claudeCodeSandbox);
  const grokSandbox = parseGrokSandboxProfile(raw.grokSandbox);
  const extraAllowWrite = parseOptionalAbsolutePathArray(
    'opts.extraAllowWrite',
    raw.extraAllowWrite,
  );
  const controls = {
    ...(permissionMode !== null ? { permissionMode } : {}),
    ...(approvalPolicy !== null ? { approvalPolicy } : {}),
    ...(sessionMode !== null ? { sessionMode } : {}),
    ...(codexSandbox !== null ? { codexSandbox } : {}),
    ...(claudeCodeSandbox !== null ? { claudeCodeSandbox } : {}),
    ...(grokSandbox !== null ? { grokSandbox } : {}),
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
    approvalPolicy,
    codexSandbox,
    claudeCodeSandbox,
    grokSandbox,
    extraAllowWrite,
  };
}

export function registerAdapterSandboxRestartIpc(): void {
  const claudeCodeDisplayName =
    getAdapterRuntimeProfile('claude-code').displayName;
  const codexCliDisplayName =
    getAdapterRuntimeProfile('codex-cli').displayName;
  const grokBuildDisplayName =
    getAdapterRuntimeProfile('grok-build').displayName;

  on(
    IpcInvoke.AdapterSetCodexApprovalPolicy,
    async (_e, agentId, sessionId, policy) => {
      const adapter = adapterRegistry.get(parseStringId('agentId', agentId, 64));
      if (
        !adapter?.capabilities.canSetCodexApprovalPolicy ||
        !adapter.setCodexApprovalPolicy
      ) {
        throw new Error(
          `当前适配器不支持修改 ${codexCliDisplayName} approvalPolicy`,
        );
      }
      const sid = parseStringId('sessionId', sessionId);
      const parsed = parseCodexApprovalPolicy(policy);
      if (parsed === null) {
        throw new IpcInputError(
          'policy',
          'required (one of untrusted|on-request|never)',
        );
      }
      return adapter.setCodexApprovalPolicy(sid, parsed);
    },
  );

  on(
    IpcInvoke.AdapterRestartWithCodexSandbox,
    async (_e, agentId, sessionId, sandbox, handoffPrompt) => {
      const adapter = adapterRegistry.get(parseStringId('agentId', agentId, 64));
      if (!adapter?.capabilities.canRestartWithCodexSandbox || !adapter.restartWithCodexSandbox) {
        throw new Error(
          `当前适配器不支持使用 ${codexCliDisplayName} 沙盒重启`,
        );
      }
      const sid = parseStringId('sessionId', sessionId);
      const profile = parseCodexSandboxMode(sandbox);
      if (profile === null) {
        throw new IpcInputError(
          'sandbox',
          'required (one of workspace-write|read-only|danger-full-access)',
        );
      }
      const prompt =
        typeof handoffPrompt === 'string' && handoffPrompt.trim()
          ? handoffPrompt
          : SDK_RESTART_RESUME_PROMPT;
      return adapter.restartWithCodexSandbox(sid, profile, prompt);
    },
  );

  on(
    IpcInvoke.AdapterRestartWithClaudeCodeSandbox,
    async (_e, agentId, sessionId, sandbox, handoffPrompt) => {
      const adapter = adapterRegistry.get(parseStringId('agentId', agentId, 64));
      if (
        !adapter?.capabilities.canRestartWithClaudeCodeSandbox ||
        !adapter.restartWithClaudeCodeSandbox
      ) {
        throw new Error(
          `当前适配器不支持使用 ${claudeCodeDisplayName} 沙盒重启`,
        );
      }
      const sid = parseStringId('sessionId', sessionId);
      const profile = parseSandboxMode(sandbox);
      if (profile === null) {
        throw new IpcInputError(
          'sandbox',
          'required (one of off|workspace-write|strict)',
        );
      }
      const prompt =
        typeof handoffPrompt === 'string' && handoffPrompt.trim()
          ? handoffPrompt
          : SDK_RESTART_RESUME_PROMPT;
      return adapter.restartWithClaudeCodeSandbox(sid, profile, prompt);
    },
  );

  on(
    IpcInvoke.AdapterRestartWithGrokSandbox,
    async (_e, agentId, sessionId, sandbox) => {
      const adapter = adapterRegistry.get(parseStringId('agentId', agentId, 64));
      if (
        !adapter?.capabilities.canRestartWithGrokSandbox ||
        !adapter.restartWithGrokSandbox
      ) {
        throw new Error(
          `当前适配器不支持使用 ${grokBuildDisplayName} 沙盒重启`,
        );
      }
      const sid = parseStringId('sessionId', sessionId);
      const profile = sandbox === null ? null : parseGrokSandboxProfile(sandbox);
      if (sandbox !== null && profile === null) {
        throw new IpcInputError('sandbox', 'required profile name or null');
      }
      return adapter.restartWithGrokSandbox(sid, profile);
    },
  );
}
