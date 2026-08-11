import {
  AgentDeckClientErrorCode,
  type JsonObject,
  type JsonValue,
} from '@contracts/index';
import { DaemonRequestError } from '@hosts/daemon';
import type { AgentAdapter } from '@main/adapters/types';
import {
  isAdapterSessionMode,
  isCodexApprovalPolicy,
  isSelectablePermissionMode,
  type SessionRecord,
} from '@shared/types';
import { serverCoreGrokSandbox } from './provider-grok-sandbox';
import { SDK_RESTART_RESUME_PROMPT } from '@shared/restart-prompts';

const CONTROL = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/u;
const MODEL_FIELDS = new Set(['model', 'provider', 'thinking']);

export interface ServerCoreRuntimeControlMutation {
  readonly effect: 'hot-applied' | 'restart-required';
  readonly replacementSessionId: string | null;
}

function invalid(message = 'Runtime patch is invalid'): never {
  throw new DaemonRequestError(AgentDeckClientErrorCode.InvalidRequest, message);
}

function unavailable(): never {
  throw new DaemonRequestError(
    AgentDeckClientErrorCode.CapabilityUnavailable,
    'Runtime control is not available',
  );
}

function optionalText(value: JsonValue | undefined): string | null {
  if (value === null) return null;
  if (
    typeof value !== 'string' || Buffer.byteLength(value) > 512 || CONTROL.test(value)
  ) invalid();
  return value;
}

export function serverCoreRuntimeValues(record: SessionRecord): JsonObject {
  const common: JsonObject = {
    model: record.model ?? null,
    provider: record.runtimeProvider ?? null,
    thinking: record.thinking ?? null,
  };
  if (record.agentId === 'claude-code') {
    return {
      ...common,
      claudeCodeSandbox: record.claudeCodeSandbox ?? null,
      permissionMode: record.permissionMode ?? 'default',
    };
  }
  if (record.agentId === 'codex-cli') {
    return {
      ...common,
      approvalPolicy: record.codexApprovalPolicy ?? null,
      codexSandbox: record.codexSandbox ?? null,
    };
  }
  if (record.agentId === 'grok-build') {
    return {
      ...common,
      grokSandbox: record.grokSandbox ?? null,
      sessionMode: record.sessionMode ?? 'default',
    };
  }
  return common;
}

function oneField(patch: JsonObject, field: string): JsonValue {
  const keys = Object.keys(patch);
  if (keys.length !== 1 || keys[0] !== field) invalid();
  return patch[field]!;
}

async function applyModelOptions(
  adapter: AgentAdapter,
  record: SessionRecord,
  patch: JsonObject,
): Promise<ServerCoreRuntimeControlMutation> {
  if (!adapter.setSessionModelOptions) unavailable();
  const keys = Object.keys(patch);
  if (keys.some((key) => !MODEL_FIELDS.has(key))) invalid();
  await adapter.setSessionModelOptions(record.id, {
    provider: patch.provider === undefined
      ? record.runtimeProvider ?? null
      : optionalText(patch.provider),
    model: patch.model === undefined ? record.model ?? null : optionalText(patch.model),
    thinking: patch.thinking === undefined
      ? record.thinking ?? null
      : optionalText(patch.thinking),
  });
  return { effect: 'hot-applied', replacementSessionId: null };
}

/** Applies exactly one provider-owned runtime operation so partial multi-controller writes cannot occur. */
export async function applyServerCoreRuntimePatch(
  adapter: AgentAdapter,
  record: SessionRecord,
  patch: JsonObject,
): Promise<ServerCoreRuntimeControlMutation> {
  const keys = Object.keys(patch);
  if (keys.every((key) => MODEL_FIELDS.has(key))) {
    return applyModelOptions(adapter, record, patch);
  }

  if (keys[0] === 'permissionMode') {
    const value = oneField(patch, 'permissionMode');
    if (record.agentId !== 'claude-code' || !isSelectablePermissionMode(value)) invalid();
    if (!adapter.setPermissionMode) unavailable();
    await adapter.setPermissionMode(record.id, value);
    return { effect: 'hot-applied', replacementSessionId: null };
  }

  if (keys[0] === 'codexSandbox') {
    const value = oneField(patch, 'codexSandbox');
    if (
      record.agentId !== 'codex-cli' || typeof value !== 'string' ||
      !['workspace-write', 'read-only', 'danger-full-access'].includes(value)
    ) invalid();
    if (!adapter.setCodexSandbox) unavailable();
    await adapter.setCodexSandbox(
      record.id,
      value as 'workspace-write' | 'read-only' | 'danger-full-access',
    );
    return { effect: 'hot-applied', replacementSessionId: null };
  }

  if (keys[0] === 'claudeCodeSandbox') {
    const value = oneField(patch, 'claudeCodeSandbox');
    if (
      record.agentId !== 'claude-code' || typeof value !== 'string' ||
      !['off', 'workspace-write', 'strict'].includes(value)
    ) invalid();
    if (!adapter.restartWithClaudeCodeSandbox) unavailable();
    const replacementSessionId = await adapter.restartWithClaudeCodeSandbox(
      record.id,
      value as 'off' | 'workspace-write' | 'strict',
      SDK_RESTART_RESUME_PROMPT,
    );
    return { effect: 'restart-required', replacementSessionId };
  }

  if (keys[0] === 'approvalPolicy') {
    const value = oneField(patch, 'approvalPolicy');
    if (record.agentId !== 'codex-cli' || !isCodexApprovalPolicy(value)) invalid();
    if (!adapter.setCodexApprovalPolicy) unavailable();
    await adapter.setCodexApprovalPolicy(record.id, value);
    return { effect: 'hot-applied', replacementSessionId: null };
  }

  if (keys[0] === 'sessionMode') {
    const value = oneField(patch, 'sessionMode');
    if (record.agentId !== 'grok-build' || !isAdapterSessionMode(value)) invalid();
    if (!adapter.setSessionMode) unavailable();
    await adapter.setSessionMode(record.id, value);
    return { effect: 'hot-applied', replacementSessionId: null };
  }

  if (keys[0] === 'grokSandbox') {
    const value = oneField(patch, 'grokSandbox');
    if (record.agentId !== 'grok-build') invalid();
    const sandbox = serverCoreGrokSandbox(optionalText(value));
    if (!adapter.restartWithGrokSandbox) unavailable();
    const replacementSessionId = await adapter.restartWithGrokSandbox(record.id, sandbox);
    return { effect: 'restart-required', replacementSessionId };
  }

  invalid();
}
