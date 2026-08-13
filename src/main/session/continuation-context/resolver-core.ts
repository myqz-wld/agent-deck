import { createHash } from 'node:crypto';
import {
  getContextWindowCapacityService,
  type ContextWindowCapacityService,
} from '@main/session/context-window/service';
import {
  DEFAULT_CAPACITY_CONFIG_FINGERPRINT,
  resolveContextRuntimeIdentity,
} from '@main/session/context-window/identity';
import {
  isClaudeThinkingLevel,
  isCodexThinkingLevel,
  isGrokThinkingLevel,
  type SessionThinkingLevel,
} from '@shared/session-metadata';
import {
  DEFAULT_CONTINUATION_RAW_RETENTION_TOKENS,
  DEFAULT_CONTINUATION_CHECKPOINT_THINKING,
  MAX_CONTINUATION_RAW_RETENTION_TOKENS,
  MIN_CONTINUATION_RAW_RETENTION_TOKENS,
  type PermissionMode,
  type AdapterSessionMode,
  type ContextRuntimeIdentity,
  type ContextRuntimeIdentityResolution,
  type ResolvedContextCapacity,
  type SessionAdapterId,
} from '@shared/types';
import type { ResolvedContinuationGenerator, ResolvedSuccessorSpec } from './types';

export function continuationFingerprint(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value), 'utf8').digest('hex');
}

export function assertSessionAdapterId(value: string): SessionAdapterId {
  if (
    value === 'claude-code' ||
    value === 'codex-cli' ||
    value === 'grok-build'
  ) {
    return value;
  }
  throw new Error(`Unsupported continuation adapter: ${value}`);
}

function configuredGeneratorThinking(
  adapter: SessionAdapterId,
  configured: unknown,
): SessionThinkingLevel {
  if (adapter === 'codex-cli') {
    return isCodexThinkingLevel(configured)
      ? configured
      : DEFAULT_CONTINUATION_CHECKPOINT_THINKING;
  }
  if (adapter === 'grok-build') {
    return isGrokThinkingLevel(configured)
      ? configured
      : DEFAULT_CONTINUATION_CHECKPOINT_THINKING;
  }
  return isClaudeThinkingLevel(configured)
    ? configured
    : DEFAULT_CONTINUATION_CHECKPOINT_THINKING;
}

function configuredGeneratorModel(
  adapter: SessionAdapterId,
  provider: string | null,
  configured: unknown,
  resolveGatewayProfile?: (provider: string | null) => {
    readonly modelAliases: { readonly sonnet?: string };
    readonly defaultModel?: string;
  } | null,
): string | null {
  const explicit = typeof configured === 'string' ? configured.trim() : '';
  if (explicit) return explicit;
  // Leaving Codex unset delegates to its active config.toml model; an intentionally blank setting
  // has no second environment-based source of truth.
  if (adapter === 'codex-cli' || adapter === 'grok-build') return null;
  const profile = resolveGatewayProfile?.(provider) ?? null;
  if (profile) {
    return profile.modelAliases.sonnet ?? profile.defaultModel ?? 'sonnet';
  }
  return (
    process.env.ANTHROPIC_DEFAULT_SONNET_MODEL?.trim() ||
    'sonnet'
  );
}

interface ContinuationGeneratorConfiguration {
  adapter: SessionAdapterId;
  provider: string | null;
  model: string | null;
  thinking: SessionThinkingLevel;
  configFingerprint: string;
}

export interface ContinuationGeneratorSettings {
  readonly continuationCheckpointAdapter: SessionAdapterId;
  readonly continuationCheckpointRuntimeProvider: string;
  readonly continuationCheckpointModel: string;
  readonly continuationCheckpointThinking: SessionThinkingLevel;
  readonly resolveClaudeGatewayProfile?: (
    provider: string | null,
  ) => {
    readonly modelAliases: { readonly sonnet?: string };
    readonly defaultModel?: string;
  } | null;
}

export interface ContinuationCapacityResolutionDependencies {
  capacityService?: ContextWindowCapacityService;
  at?: number;
}

function generatorConfiguration(
  settings: ContinuationGeneratorSettings,
): ContinuationGeneratorConfiguration {
  const adapter = settings.continuationCheckpointAdapter;
  const provider =
    adapter === 'grok-build'
      ? null
      : settings.continuationCheckpointRuntimeProvider.trim() || null;
  const model = configuredGeneratorModel(
    adapter,
    provider,
    settings.continuationCheckpointModel,
    settings.resolveClaudeGatewayProfile,
  );
  const thinking = configuredGeneratorThinking(
    adapter,
    settings.continuationCheckpointThinking,
  );
  const configFingerprint = continuationFingerprint({
    version: 3,
    adapter,
    provider,
    model,
    thinking,
  });
  return {
    adapter,
    provider,
    model,
    thinking,
    configFingerprint,
  };
}

/** Configuration freshness excludes mutable capacity observations by construction. */
export function resolveContinuationGeneratorConfigFingerprintFromSettings(
  settings: ContinuationGeneratorSettings,
): string {
  return generatorConfiguration(settings).configFingerprint;
}

function isUnresolvedModelAlias(adapter: SessionAdapterId, model: string): boolean {
  if (adapter === 'codex-cli') return model === 'codex-default';
  if (/^(?:claude-)?(?:fable|opus|sonnet|haiku)$/i.test(model)) return true;
  return adapter === 'grok-build' && /(?:^|[-_.])(?:default|latest)$/i.test(model);
}

function configuredRuntimeProvider(
  adapter: SessionAdapterId,
  provider: string | null | undefined,
): string | null {
  if (adapter === 'grok-build') return 'native';
  if (adapter === 'claude-code') return provider?.trim() || 'native';
  return provider?.trim() || null;
}

export function resolveContinuationRuntimeIdentity(input: {
  adapter: SessionAdapterId;
  provider?: string | null;
  model: string | null;
  /** Capacity-affecting config the target will actually receive. */
  capacityConfigFingerprint?: string | null;
  trustedRuntimeIdentity?: ContextRuntimeIdentity | null;
}): ContextRuntimeIdentityResolution {
  const runtimeProvider = configuredRuntimeProvider(input.adapter, input.provider);
  const trusted = input.trustedRuntimeIdentity;
  const targetCapacityConfigFingerprint =
    input.capacityConfigFingerprint?.trim() || DEFAULT_CAPACITY_CONFIG_FINGERPRINT;
  const trustedEquivalent = trusted
    ? resolveContextRuntimeIdentity({
        adapter: input.adapter,
        runtimeProvider,
        model: trusted.model,
        capacityConfigFingerprint: input.capacityConfigFingerprint,
      })
    : null;
  if (
    trusted &&
    trustedEquivalent?.status === 'concrete' &&
    trusted.adapter === input.adapter &&
    trusted.runtimeProvider === runtimeProvider &&
    trusted.capacityConfigFingerprint === targetCapacityConfigFingerprint
  ) {
    return { status: 'concrete', identity: trusted };
  }
  return resolveContextRuntimeIdentity({
    adapter: input.adapter,
    runtimeProvider,
    model: input.model,
    capacityConfigFingerprint: input.capacityConfigFingerprint,
    ...(input.model && isUnresolvedModelAlias(input.adapter, input.model)
      ? { unavailableReason: 'unresolved-model-alias' as const }
      : {}),
  });
}

function resolveFrozenCapacity(
  identity: ContextRuntimeIdentityResolution,
  dependencies: ContinuationCapacityResolutionDependencies,
) {
  const service = dependencies.capacityService ?? getContextWindowCapacityService();
  return service.resolve(identity, dependencies.at);
}

/** Resolve the same generator snapshot from an authoritative non-Desktop settings host. */
export function resolveContinuationGeneratorSnapshotFromSettings(
  settings: ContinuationGeneratorSettings,
  dependencies: ContinuationCapacityResolutionDependencies = {},
): ResolvedContinuationGenerator {
  const configuration = generatorConfiguration(settings);
  const identity = resolveContinuationRuntimeIdentity(configuration);
  return {
    ...configuration,
    contextCapacity: resolveFrozenCapacity(identity, dependencies),
  };
}

export function resolveContinuationRawRetentionCeilingFromValue(configured: unknown): number {
  return typeof configured === 'number' &&
    Number.isSafeInteger(configured) &&
    configured >= MIN_CONTINUATION_RAW_RETENTION_TOKENS &&
    configured <= MAX_CONTINUATION_RAW_RETENTION_TOKENS
    ? configured
    : DEFAULT_CONTINUATION_RAW_RETENTION_TOKENS;
}

function targetThinking(
  adapter: SessionAdapterId,
  value: string | null | undefined,
): SessionThinkingLevel | null {
  if (adapter === 'codex-cli') return isCodexThinkingLevel(value) ? value : null;
  if (adapter === 'grok-build') return isGrokThinkingLevel(value) ? value : null;
  return isClaudeThinkingLevel(value) ? value : null;
}

export interface ResolveContinuationTargetInput {
  adapter: SessionAdapterId;
  cwd: string;
  provider?: string | null;
  model: string | null;
  thinking: string | null;
  permissionMode: PermissionMode | null;
  sessionMode?: AdapterSessionMode | null;
  sandbox: unknown;
  networkAccessEnabled: boolean | null;
  additionalDirectories: readonly string[];
  /** Capacity-affecting config reconstructed from the actual target create options. */
  capacityConfigFingerprint?: string | null;
  /** Exact adapter-native identity inherited from an already running equivalent runtime. */
  trustedRuntimeIdentity?: ContextRuntimeIdentity | null;
  /** Optional source DB-runtime fingerprint used by same-session recovery snapshots. */
  sourceRuntimeFingerprint?: string;
}

export function resolveContinuationTargetSnapshot(
  input: ResolveContinuationTargetInput,
  dependencies: ContinuationCapacityResolutionDependencies = {},
): ResolvedSuccessorSpec {
  return resolveContinuationTargetFromFrozenCapacity(
    input,
    resolveFrozenCapacity(
      resolveContinuationRuntimeIdentity({
        adapter: input.adapter,
        provider: input.provider,
        model: input.model,
        capacityConfigFingerprint: input.capacityConfigFingerprint,
        trustedRuntimeIdentity: input.trustedRuntimeIdentity,
      }),
      dependencies,
    ),
  );
}

/** Rebuild runtime/create fingerprints without consulting mutable capacity evidence. */
export function resolveContinuationTargetFromFrozenCapacity(
  input: ResolveContinuationTargetInput,
  contextCapacity: ResolvedContextCapacity,
): ResolvedSuccessorSpec {
  const thinking = targetThinking(input.adapter, input.thinking);
  const additionalDirectories = [...input.additionalDirectories];
  const runtime = {
    version: 3,
    sourceRuntimeFingerprint: input.sourceRuntimeFingerprint ?? null,
    adapter: input.adapter,
    cwd: input.cwd,
    provider: input.provider ?? null,
    model: input.model,
    thinking,
    permissionMode: input.permissionMode,
    sessionMode: input.sessionMode ?? null,
    sandbox: input.sandbox,
    networkAccessEnabled: input.networkAccessEnabled,
    additionalDirectories,
    capacityConfigFingerprint:
      input.capacityConfigFingerprint?.trim() || DEFAULT_CAPACITY_CONFIG_FINGERPRINT,
  };
  return {
    adapter: input.adapter,
    provider: input.provider ?? null,
    model: input.model,
    thinking,
    sandbox: input.sandbox,
    permissionMode: input.permissionMode,
    sessionMode: input.sessionMode ?? null,
    networkAccessEnabled: input.networkAccessEnabled,
    additionalDirectories,
    contextCapacity,
    runtimeFingerprint: continuationFingerprint(runtime),
  };
}
