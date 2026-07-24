import { createHash } from 'node:crypto';
import { resolveClaudeGatewayProfile } from '@main/adapters/claude-code/gateway-profiles';
import { settingsStore } from '@main/store/settings-store';
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
  type SessionAdapterId,
} from '@shared/types';
import { contextCapacityResolver } from './context-capacity-resolver';
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

function configuredGeneratorAdapter(): SessionAdapterId {
  return settingsStore.get('continuationCheckpointAdapter');
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
): string | null {
  const explicit = typeof configured === 'string' ? configured.trim() : '';
  if (explicit) return explicit;
  // Leaving Codex unset delegates to its active config.toml model. Do not let a legacy hidden env
  // override turn an intentionally blank setting into a second, invisible source of truth.
  if (adapter === 'codex-cli' || adapter === 'grok-build') return null;
  const profile = resolveClaudeGatewayProfile(provider);
  if (profile) {
    return profile.modelAliases.sonnet ?? profile.defaultModel ?? 'sonnet';
  }
  return (
    process.env.ANTHROPIC_DEFAULT_SONNET_MODEL?.trim() ||
    'sonnet'
  );
}

export function resolveContinuationGeneratorSnapshot(): ResolvedContinuationGenerator {
  const adapter = configuredGeneratorAdapter();
  const provider =
    adapter === 'grok-build'
      ? null
      : settingsStore.get('continuationCheckpointRuntimeProvider').trim() || null;
  const model = configuredGeneratorModel(
    adapter,
    provider,
    settingsStore.get('continuationCheckpointModel'),
  );
  const thinking = configuredGeneratorThinking(
    adapter,
    settingsStore.get('continuationCheckpointThinking'),
  );
  return {
    adapter,
    provider,
    model,
    thinking,
    contextWindowTokens: null,
    configFingerprint: continuationFingerprint({
      version: 2,
      adapter,
      provider,
      model,
      thinking,
    }),
  };
}

export function resolveContinuationRawRetentionCeiling(): number {
  const configured = settingsStore.get('continuationRawRetentionTokens');
  return Number.isSafeInteger(configured) &&
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
  contextWindowTokens?: number | null;
  contextWindowSource?: 'observed' | 'fallback' | null;
  /** Optional source DB-runtime fingerprint used by same-session recovery snapshots. */
  sourceRuntimeFingerprint?: string;
}

export function resolveContinuationTargetSnapshot(
  input: ResolveContinuationTargetInput,
): ResolvedSuccessorSpec {
  const thinking = targetThinking(input.adapter, input.thinking);
  const additionalDirectories = [...input.additionalDirectories];
  const capacity =
    input.contextWindowTokens == null
      ? contextCapacityResolver.resolve(input.adapter, input.model)
      : {
          contextWindowTokens: input.contextWindowTokens,
          source: input.contextWindowSource ?? ('observed' as const),
        };
  const runtime = {
    version: 1,
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
    contextWindowTokens: capacity.contextWindowTokens,
    contextWindowSource: capacity.source,
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
    contextWindowTokens: capacity.contextWindowTokens,
    contextWindowSource: capacity.source,
    runtimeFingerprint: continuationFingerprint(runtime),
  };
}
