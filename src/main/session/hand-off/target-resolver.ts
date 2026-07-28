import { buildCreateSessionOptions } from '@main/adapters/options-builder';
import {
  firstUnsupportedTargetRuntimeField,
  unsupportedTargetRuntimeFieldMessage,
} from '@main/adapters/runtime-control-contracts';
import { resolveCreateSessionModelOptions } from '@main/adapters/session-model-options';
import type { CreateSessionOptions } from '@main/adapters/types';
import { settingsStore } from '@main/store/settings-store';
import { omitUndefined } from '@main/utils/optional-fields';
import type {
  AdapterSessionMode,
  SelectablePermissionMode,
  SessionAdapterId,
  SessionRecord,
} from '@shared/types';
import { isSelectablePermissionMode } from '@shared/types';
import { normalizeGrokSandboxProfile } from '@shared/grok-sandbox';
import type { ResolvedSuccessorSpec } from '../continuation-context/types';
import { resolveContinuationTargetSnapshot } from '../continuation-context/resolver';

export interface HandOffTargetRequest {
  adapter: SessionAdapterId;
  cwd: string;
  provider?: unknown;
  model?: unknown;
  thinking?: unknown;
  permissionMode?: SelectablePermissionMode;
  sessionMode?: AdapterSessionMode | null;
  codexSandbox?: 'workspace-write' | 'read-only' | 'danger-full-access';
  claudeCodeSandbox?: 'off' | 'workspace-write' | 'strict';
  grokSandbox?: string | null;
  extraAllowWrite?: readonly string[];
  networkAccessEnabled?: boolean;
  additionalDirectories?: readonly string[];
}

export interface ResolvedHandOffTarget {
  spec: ResolvedSuccessorSpec;
  createOptions: CreateSessionOptions;
}

export class HandOffTargetOptionsError extends Error {
  constructor(
    readonly field: keyof HandOffTargetRequest,
    message: string,
  ) {
    super(message);
    this.name = 'HandOffTargetOptionsError';
  }
}

function defaultPermissionMode(
  adapter: SessionAdapterId,
): SelectablePermissionMode | undefined {
  return adapter === 'claude-code' ? 'bypassPermissions' : undefined;
}

export function resolveHandOffTarget(input: {
  source: SessionRecord;
  request: HandOffTargetRequest;
  sourceMaxEventId: number | null;
}): ResolvedHandOffTarget {
  const { source, request } = input;
  const sameAdapter = request.adapter === source.agentId;
  const unsupported = firstUnsupportedTargetRuntimeField(request.adapter, request);
  if (unsupported !== null) {
    throw new HandOffTargetOptionsError(
      unsupported,
      unsupportedTargetRuntimeFieldMessage(request.adapter, unsupported),
    );
  }
  if (request.adapter !== 'codex-cli') {
    if (request.networkAccessEnabled !== undefined) {
      throw new HandOffTargetOptionsError(
        'networkAccessEnabled',
        'networkAccessEnabled is compatible only with codex-cli',
      );
    }
    if (request.additionalDirectories !== undefined) {
      throw new HandOffTargetOptionsError(
        'additionalDirectories',
        'additionalDirectories is compatible only with codex-cli',
      );
    }
  }
  const requestedModel =
    request.model !== undefined ? request.model : sameAdapter ? source.model ?? null : null;
  const requestedProvider =
    request.provider !== undefined
      ? request.provider
      : sameAdapter && request.adapter !== 'grok-build'
        ? source.runtimeProvider ?? null
        : null;
  const requestedThinking =
    request.thinking !== undefined
      ? request.thinking
      : sameAdapter
        ? source.thinking ?? null
        : null;
  const modelOptions = resolveCreateSessionModelOptions(request.adapter, {
    provider: requestedProvider,
    model: requestedModel,
    thinking: requestedThinking,
  });
  const permissionMode =
    request.permissionMode ??
    (sameAdapter
      ? request.adapter === 'claude-code'
        ? isSelectablePermissionMode(source.permissionMode)
          ? source.permissionMode
          : 'default'
        : undefined
      : defaultPermissionMode(request.adapter));
  const sessionMode =
    request.adapter === 'grok-build'
      ? request.sessionMode ??
        (sameAdapter ? source.sessionMode ?? undefined : undefined)
      : undefined;
  const codexSandbox =
    request.adapter === 'codex-cli'
      ? request.codexSandbox ??
        (sameAdapter ? source.codexSandbox ?? undefined : undefined) ??
        settingsStore.get('codexSandbox')
      : undefined;
  const claudeCodeSandbox =
    request.adapter === 'claude-code'
      ? request.claudeCodeSandbox ??
        (sameAdapter ? source.claudeCodeSandbox ?? undefined : undefined) ??
        settingsStore.get('claudeCodeSandbox')
      : undefined;
  let grokSandbox: string | null | undefined;
  if (request.adapter === 'grok-build') {
    const candidate =
      request.grokSandbox !== undefined
        ? request.grokSandbox
        : sameAdapter
          ? source.grokSandbox ?? null
          : settingsStore.get('grokSandbox');
    try {
      grokSandbox =
        candidate === null ? null : normalizeGrokSandboxProfile(candidate);
    } catch (error) {
      throw new HandOffTargetOptionsError(
        'grokSandbox',
        error instanceof Error ? error.message : String(error),
      );
    }
  }
  const extraAllowWrite =
    request.adapter === 'grok-build'
      ? []
      : request.extraAllowWrite !== undefined
      ? [...request.extraAllowWrite]
      : sameAdapter
        ? [...(source.extraAllowWrite ?? [])]
        : [];
  const networkAccessEnabled =
    request.adapter === 'grok-build'
      ? null
      : request.networkAccessEnabled !== undefined
      ? request.networkAccessEnabled
      : sameAdapter
        ? source.networkAccessEnabled ?? null
        : null;
  const additionalDirectories =
    request.adapter === 'grok-build'
      ? []
      : request.additionalDirectories !== undefined
      ? [...request.additionalDirectories]
      : sameAdapter
        ? [...(source.additionalDirectories ?? [])]
        : [];
  const codexApprovalPolicy =
    request.adapter === 'codex-cli' && sameAdapter
      ? source.codexApprovalPolicy ?? null
      : null;
  const createOptions = buildCreateSessionOptions(request.adapter, {
    cwd: request.cwd,
    ...modelOptions,
    ...omitUndefined({
      permissionMode,
      sessionMode,
      codexSandbox,
      claudeCodeSandbox,
      grokSandbox,
      networkAccessEnabled:
        networkAccessEnabled === null ? undefined : networkAccessEnabled,
      handOff: {
        mode: 'session' as const,
        fromCallerSid: source.id,
        sourceMaxEventId: input.sourceMaxEventId,
      },
      awaitCanonicalId: true,
    }),
    ...(extraAllowWrite.length > 0 ? { extraAllowWrite } : {}),
    ...(additionalDirectories.length > 0 ? { additionalDirectories } : {}),
  });
  // Public spawn deliberately reserves these fields for reviewer defaults, but authenticated
  // handoff must preserve the already-persisted Codex runtime exactly across replacement.
  if (createOptions.agentId === 'codex-cli') {
    if (codexApprovalPolicy !== null) {
      createOptions.approvalPolicy = codexApprovalPolicy;
    }
    if (networkAccessEnabled !== null) {
      createOptions.networkAccessEnabled = networkAccessEnabled;
    }
    if (additionalDirectories.length > 0) {
      createOptions.additionalDirectories = additionalDirectories;
    }
  }
  const model = modelOptions.model ?? null;
  const provider = modelOptions.provider ?? null;
  const thinking =
    modelOptions.modelReasoningEffort ??
    modelOptions.claudeCodeEffortLevel ??
    modelOptions.reasoningEffort ??
    null;
  const sandbox =
    request.adapter === 'grok-build'
      ? { kind: 'grok', profile: grokSandbox ?? null }
      : request.adapter === 'codex-cli'
      ? {
          kind: 'codex',
          mode: codexSandbox ?? null,
          extraAllowWriteEffective: true,
          persistedExtraAllowWrite: extraAllowWrite,
        }
      : { kind: 'claude', mode: claudeCodeSandbox ?? null, extraAllowWrite };
  const spec = resolveContinuationTargetSnapshot({
    adapter: request.adapter,
    cwd: request.cwd,
    provider,
    model,
    thinking,
    permissionMode: permissionMode ?? null,
    sessionMode: sessionMode ?? null,
    sandbox,
    networkAccessEnabled,
    additionalDirectories,
  });
  return { spec, createOptions };
}
