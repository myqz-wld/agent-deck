import {
  parseSessionConsoleAttachments,
  type SessionConsoleCreateOptionKey,
} from '@contracts/index';
import type { useImageAttachments } from '@renderer/hooks/useImageAttachments';
import type { useSessionCreationOptions } from '@renderer/hooks/useSessionCreationOptions';
import { adapterSessionModeOptions } from '@renderer/lib/adapter-session-modes';
import {
  CLAUDE_SANDBOX_OPTIONS,
  CODEX_APPROVAL_POLICY_OPTIONS,
  CODEX_SANDBOX_OPTIONS,
  PERMISSION_OPTIONS,
} from '@renderer/lib/sandbox-options';
import type {
  RemoteSessionCreateInput,
  RemoteSessionSourceView,
} from '@renderer/remote-host/source-types';
import type { AdapterSessionMode } from '@shared/types';
import type { NewSessionSelectControl } from './NewSessionForm';
import { closedSessionOptions, remoteSandboxOptions } from './remote-sandbox-options';
import {
  localSessionOptionKeys,
  remoteSessionOptionKeys,
  sessionOptionLabel,
} from './session-option-catalog';
import type { useRemoteSessionCreation } from './useRemoteSessionCreation';

type LocalCreationOptions = ReturnType<typeof useSessionCreationOptions>;
type RemoteCreation = ReturnType<typeof useRemoteSessionCreation>;
type ImageInputs = ReturnType<ReturnType<typeof useImageAttachments>['toIpcInputs']>;

export interface LocalSessionAdapterInfo {
  id: string;
  displayName: string;
  capabilities: {
    canCreateSession?: boolean;
    canSetPermissionMode?: boolean;
    canSetSessionMode?: boolean;
    canAcceptAttachments?: boolean;
  };
  sessionModes: AdapterSessionMode[];
}

export function remoteControls(
  descriptor: RemoteCreation['descriptor'],
  values: RemoteCreation['options'],
  setOption: (key: SessionConsoleCreateOptionKey, value: string) => void,
): NewSessionSelectControl[] {
  if (!descriptor) return [];
  const result: NewSessionSelectControl[] = [];
  const add = (key: SessionConsoleCreateOptionKey): void => {
    const schema = descriptor.create.options[key];
    const value = values[key];
    if (!schema.enabled || value === null || !schema.allowedValues) {
      result.push({
        label: sessionOptionLabel(key), value: '', options: [],
        disabledReason: schema.disabledReason ?? '当前 Remote Worker 未提供此选项。',
        onChange: () => undefined,
      });
      return;
    }
    result.push({
      label: sessionOptionLabel(key), value,
      options: closedSessionOptions(schema.allowedValues),
      onChange: (next) => setOption(key, next),
    });
  };
  for (const key of remoteSessionOptionKeys(descriptor)) {
    if (key !== descriptor.create.sandbox.optionKey) {
      add(key);
      continue;
    }
    const value = values[key];
    const schema = descriptor.create.options[key];
    result.push(schema.enabled && value !== null ? {
      label: sessionOptionLabel(key), value,
      options: remoteSandboxOptions(descriptor.create.sandbox.choices, key),
      onChange: (next) => setOption(key, next),
    } : {
      label: sessionOptionLabel(key), value: '', options: [],
      disabledReason: schema.disabledReason ?? '当前 Remote Worker 未提供此沙盒选项。',
      onChange: () => undefined,
    });
  }
  return result;
}

export function localControls(
  adapterId: string,
  adapter: LocalSessionAdapterInfo | undefined,
  options: LocalCreationOptions,
): NewSessionSelectControl[] {
  const result: NewSessionSelectControl[] = [];
  const keys = localSessionOptionKeys(adapterId, {
    canSetPermissionMode: adapter?.capabilities?.canSetPermissionMode === true,
    canSetSessionMode: adapter?.capabilities?.canSetSessionMode === true,
    hasSessionModes: (adapter?.sessionModes?.length ?? 0) > 0,
  });
  for (const key of keys) {
    if (key === 'permissionMode') {
      result.push({ label: sessionOptionLabel(key), value: options.permissionMode,
        options: PERMISSION_OPTIONS, onChange: (value) => options.setPermissionMode(
          value as Parameters<typeof options.setPermissionMode>[0]) });
    } else if (key === 'sessionMode') {
      result.push({ label: sessionOptionLabel(key), value: options.sessionMode,
        options: adapterSessionModeOptions(adapter?.sessionModes ?? []), onChange: (value) =>
          options.setSessionMode(value as Parameters<typeof options.setSessionMode>[0]) });
    } else if (key === 'approvalPolicy') {
      result.push({ label: sessionOptionLabel(key), value: options.approvalPolicy,
        options: CODEX_APPROVAL_POLICY_OPTIONS, onChange: (value) =>
          options.setApprovalPolicy(value as Parameters<typeof options.setApprovalPolicy>[0]) });
    } else if (key === 'codexSandbox') {
      result.push({ label: sessionOptionLabel(key), value: options.codexSandbox,
        options: CODEX_SANDBOX_OPTIONS, onChange: (value) =>
          options.setCodexSandbox(value as Parameters<typeof options.setCodexSandbox>[0]) });
    } else if (key === 'claudeCodeSandbox') {
      result.push({ label: sessionOptionLabel(key), value: options.claudeCodeSandbox,
        options: CLAUDE_SANDBOX_OPTIONS, onChange: (value) =>
          options.setClaudeCodeSandbox(value as Parameters<typeof options.setClaudeCodeSandbox>[0]) });
    } else if (key === 'grokSandbox') {
      result.push({ label: sessionOptionLabel(key), value: options.grokSandbox,
        options: [], customGrok: true, onChange: options.setGrokSandbox });
    }
  }
  return result;
}

export async function submitRemoteSession(
  source: RemoteSessionSourceView | null,
  remote: RemoteCreation,
  workingDirectory: string,
  prompt: string,
  attachments: ImageInputs,
): Promise<string> {
  if (!source || !remote.descriptor) throw new Error('远程运行时配置尚未就绪。');
  return source.createSession(buildRemoteSessionCreateInput(
    remote, workingDirectory, prompt, attachments,
  ));
}

export function buildRemoteSessionCreateInput(
  remote: RemoteCreation,
  workingDirectory: string,
  prompt: string,
  attachments: ImageInputs,
): RemoteSessionCreateInput {
  if (!remote.descriptor) throw new Error('远程运行时配置尚未就绪。');
  const validatedAttachments = parseSessionConsoleAttachments(attachments);
  const policy = remote.descriptor.create.attachments;
  const totalBytes = validatedAttachments.reduce((sum, item) => sum + item.bytes, 0);
  if (
    validatedAttachments.length > policy.maxCount ||
    validatedAttachments.some((item) =>
      item.bytes > policy.maxBytesEach || !policy.mimeTypes.includes(item.mime)) ||
    totalBytes > policy.maxBytesTotal
  ) {
    throw new Error('图片超过当前 Remote Core 协商的传输限制；图片仍保留，可移除后重试。');
  }
  return {
    adapterId: remote.adapterId,
    attachments: validatedAttachments,
    capabilityRevision: remote.descriptor.capabilityRevision,
    initialMessage: prompt.trim(),
    options: remote.options,
    workingDirectory: workingDirectory.trim() || '.',
  };
}

export async function submitLocalSession(
  adapterId: string,
  adapter: LocalSessionAdapterInfo | undefined,
  options: LocalCreationOptions,
  cwd: string,
  prompt: string,
  attachments: ImageInputs,
): Promise<string> {
  return window.api.createAdapterSession(adapterId, {
    cwd: cwd.trim(), prompt: prompt.trim() || undefined,
    permissionMode: adapter?.capabilities.canSetPermissionMode ? options.permissionMode : undefined,
    sessionMode: adapter?.capabilities.canSetSessionMode ? options.sessionMode : undefined,
    approvalPolicy: adapterId === 'codex-cli' ? options.approvalPolicy : undefined,
    codexSandbox: adapterId === 'codex-cli' ? options.codexSandbox : undefined,
    claudeCodeSandbox: adapterId === 'claude-code' ? options.claudeCodeSandbox : undefined,
    grokSandbox: adapterId === 'grok-build' ? options.grokSandbox.trim() : undefined,
    ...((adapterId === 'claude-code' || adapterId === 'codex-cli') && options.provider.trim()
      ? { provider: options.provider.trim() } : {}),
    ...(options.model.trim() ? { model: options.model.trim() } : {}),
    ...(options.thinking ? { thinking: options.thinking } : {}),
    ...(attachments.length > 0 ? { attachments } : {}),
  });
}
