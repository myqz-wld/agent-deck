import { buildCreateSessionOptions } from '@main/adapters/options-builder';
import { resolveCreateSessionModelOptions } from '@main/adapters/session-model-options';
import type { CreateSessionOptions } from '@main/adapters/types';
import { settingsStore } from '@main/store/settings-store';
import { omitUndefined } from '@main/utils/optional-fields';
import type { PermissionMode, SessionAdapterId, SessionRecord } from '@shared/types';
import type { ResolvedSuccessorSpec } from '../continuation-context/types';
import { resolveContinuationTargetSnapshot } from '../continuation-context/resolver';

export interface HandOffTargetRequest {
  adapter: SessionAdapterId;
  cwd: string;
  model?: unknown;
  thinking?: unknown;
  permissionMode?: PermissionMode;
  codexSandbox?: 'workspace-write' | 'read-only' | 'danger-full-access';
  claudeCodeSandbox?: 'off' | 'workspace-write' | 'strict';
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

function defaultPermissionMode(adapter: SessionAdapterId): PermissionMode | undefined {
  return adapter === 'codex-cli' ? undefined : 'bypassPermissions';
}

export function resolveHandOffTarget(input: {
  source: SessionRecord;
  request: HandOffTargetRequest;
  sourceMaxEventId: number | null;
}): ResolvedHandOffTarget {
  const { source, request } = input;
  const sameAdapter = request.adapter === source.agentId;
  if (request.adapter === 'codex-cli') {
    if (request.permissionMode !== undefined) {
      throw new HandOffTargetOptionsError(
        'permissionMode',
        'permissionMode is supported only by Claude-family targets',
      );
    }
    if (request.claudeCodeSandbox !== undefined) {
      throw new HandOffTargetOptionsError(
        'claudeCodeSandbox',
        'claudeCodeSandbox is incompatible with codex-cli',
      );
    }
    if (request.extraAllowWrite !== undefined && request.extraAllowWrite.length > 0) {
      throw new HandOffTargetOptionsError(
        'extraAllowWrite',
        'codex-cli does not enforce extraAllowWrite; use additionalDirectories or omit it',
      );
    }
  } else {
    if (request.codexSandbox !== undefined) {
      throw new HandOffTargetOptionsError(
        'codexSandbox',
        'codexSandbox is compatible only with codex-cli',
      );
    }
    if (request.networkAccessEnabled !== undefined) {
      throw new HandOffTargetOptionsError(
        'networkAccessEnabled',
        'networkAccessEnabled is compatible only with codex-cli',
      );
    }
    if (request.additionalDirectories !== undefined && request.additionalDirectories.length > 0) {
      throw new HandOffTargetOptionsError(
        'additionalDirectories',
        'additionalDirectories is compatible only with codex-cli',
      );
    }
  }
  const requestedModel =
    request.model !== undefined ? request.model : sameAdapter ? source.model ?? null : null;
  const requestedThinking =
    request.thinking !== undefined
      ? request.thinking
      : sameAdapter
        ? source.thinking ?? null
        : null;
  const modelOptions = resolveCreateSessionModelOptions(request.adapter, {
    model: requestedModel,
    thinking: requestedThinking,
  });
  const permissionMode =
    request.permissionMode ??
    (sameAdapter
      ? request.adapter === 'codex-cli'
        ? undefined
        : source.permissionMode ?? 'default'
      : defaultPermissionMode(request.adapter));
  const codexSandbox =
    request.adapter === 'codex-cli'
      ? request.codexSandbox ??
        (sameAdapter ? source.codexSandbox ?? undefined : undefined) ??
        settingsStore.get('codexSandbox')
      : undefined;
  const claudeCodeSandbox =
    request.adapter === 'codex-cli'
      ? undefined
      : request.claudeCodeSandbox ??
        (sameAdapter ? source.claudeCodeSandbox ?? undefined : undefined) ??
        settingsStore.get('claudeCodeSandbox');
  const extraAllowWrite =
    request.extraAllowWrite !== undefined
      ? [...request.extraAllowWrite]
      : sameAdapter
        ? [...(source.extraAllowWrite ?? [])]
        : [];
  const networkAccessEnabled =
    request.networkAccessEnabled !== undefined
      ? request.networkAccessEnabled
      : sameAdapter
        ? source.networkAccessEnabled ?? null
        : null;
  const additionalDirectories =
    request.additionalDirectories !== undefined
      ? [...request.additionalDirectories]
      : sameAdapter
        ? [...(source.additionalDirectories ?? [])]
        : [];
  const createOptions = buildCreateSessionOptions(request.adapter, {
    cwd: request.cwd,
    ...modelOptions,
    ...omitUndefined({
      permissionMode,
      codexSandbox,
      claudeCodeSandbox,
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
  // Public spawn deliberately reserves these two fields for reviewer defaults, but authenticated
  // handoff must preserve the already-persisted Codex runtime exactly across replacement.
  if (createOptions.agentId === 'codex-cli') {
    if (networkAccessEnabled !== null) {
      createOptions.networkAccessEnabled = networkAccessEnabled;
    }
    if (additionalDirectories.length > 0) {
      createOptions.additionalDirectories = additionalDirectories;
    }
  }
  const model = modelOptions.model ?? null;
  const thinking =
    modelOptions.modelReasoningEffort ?? modelOptions.claudeCodeEffortLevel ?? null;
  const sandbox =
    request.adapter === 'codex-cli'
      ? {
          kind: 'codex',
          mode: codexSandbox ?? null,
          extraAllowWriteEffective: false,
          persistedExtraAllowWrite: extraAllowWrite,
        }
      : { kind: 'claude', mode: claudeCodeSandbox ?? null, extraAllowWrite };
  const spec = resolveContinuationTargetSnapshot({
    adapter: request.adapter,
    cwd: request.cwd,
    model,
    thinking,
    permissionMode: permissionMode ?? null,
    sandbox,
    networkAccessEnabled,
    additionalDirectories,
  });
  return { spec, createOptions };
}
