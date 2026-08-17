import { resolveSpawnCwd } from '@main/utils/cwd-resolver';
import { CODEX_DEFAULT_BUCKET } from '@shared/model-normalize';
import type { ResolvedCodexGatewayProfile } from '@main/codex-config/gateway-profiles-core';
import { MAX_MESSAGE_LENGTH } from '../constants';
import type { CreateSessionOpts } from '../create-session/_deps';
import {
  hasCodexReasoningConfigLayer,
  resolveCodexReasoningEffort,
} from '../create-session/reasoning-effort-resolve';
import {
  buildCodexThreadOptions,
  type CodexThreadOptions,
} from '../thread-options-builder';

export interface CodexForkTargetRuntime {
  cwd: string;
  sandboxMode: 'workspace-write' | 'read-only' | 'danger-full-access';
  threadOptions: CodexThreadOptions;
  effectiveDeveloperInstructions?: string;
  persistedModel: string;
  persistedReasoningEffort?: CreateSessionOpts['modelReasoningEffort'];
}

export interface CodexForkTargetRuntimeHost {
  defaultSandboxMode: CodexForkTargetRuntime['sandboxMode'];
  developerInstructions?: string;
  readConfiguredModel: () => string | null;
  readConfiguredReasoningEffort: () =>
    NonNullable<CreateSessionOpts['modelReasoningEffort']> | null;
  readGatewayProfile: (
    gateway: string | null | undefined,
  ) => ResolvedCodexGatewayProfile | null;
}

export function resolveCodexForkTargetRuntime(
  opts: CreateSessionOpts,
  host: CodexForkTargetRuntimeHost,
): CodexForkTargetRuntime {
  if (!opts.prompt || !opts.prompt.trim()) {
    throw new Error('Codex native fork requires a non-empty delegated prompt.');
  }
  if (opts.prompt.length > MAX_MESSAGE_LENGTH) {
    throw new Error(
      `Codex native fork prompt exceeds the ${MAX_MESSAGE_LENGTH.toLocaleString()} character limit.`,
    );
  }

  const cwd = resolveSpawnCwd(opts);
  const sandboxMode = opts.codexSandbox ?? host.defaultSandboxMode;
  const gateway = host.readGatewayProfile(opts.provider);
  const hasReasoningConfigLayer = hasCodexReasoningConfigLayer(opts.codexConfigOverrides);
  const reasoning = resolveCodexReasoningEffort({
    explicit: opts.modelReasoningEffort,
    isResume: false,
    persisted: null,
    hasLayerOverride: hasReasoningConfigLayer,
    readConfigured: () => gateway
      ? gateway.defaultThinking ?? null
      : host.readConfiguredReasoningEffort(),
  });
  const effectiveDeveloperInstructions = combineCodexDeveloperInstructions(
    host.developerInstructions,
    opts.developerInstructions,
  );
  return {
    cwd,
    sandboxMode,
    effectiveDeveloperInstructions,
    persistedModel:
      opts.model ??
      gateway?.defaultModel ??
      (gateway ? null : host.readConfiguredModel()) ??
      CODEX_DEFAULT_BUCKET,
    persistedReasoningEffort: reasoning.sessionValue,
    threadOptions: buildCodexThreadOptions({
      workingDirectory: cwd,
      sandboxMode,
      approvalPolicy: opts.approvalPolicy,
      modelProvider: gateway?.modelProvider,
      model: opts.model ?? gateway?.defaultModel,
      modelReasoningEffort: reasoning.threadValue,
      developerInstructions: effectiveDeveloperInstructions,
      configOverrides: opts.codexConfigOverrides,
      gatewayConfigOverrides: gateway?.configOverrides,
      networkAccessEnabled: opts.networkAccessEnabled,
      additionalDirectories: opts.additionalDirectories,
      extraAllowWrite: opts.extraAllowWrite,
    }),
  };
}

export function combineCodexDeveloperInstructions(
  ...parts: Array<string | undefined>
): string | undefined {
  const filtered = parts.map((part) => part?.trim()).filter((part): part is string => !!part);
  return filtered.length > 0 ? filtered.join('\n\n---\n\n') : undefined;
}
