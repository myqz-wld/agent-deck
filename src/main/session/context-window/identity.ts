import type {
  ContextRuntimeIdentity,
  ContextRuntimeIdentityResolution,
  ContextRuntimeIdentityUnavailableReason,
  SessionAdapterId,
} from '@shared/types';

export const DEFAULT_CAPACITY_CONFIG_FINGERPRINT = 'default';
const MAX_IDENTITY_COMPONENT_LENGTH = 1_024;

export interface ResolveContextRuntimeIdentityInput {
  adapter: SessionAdapterId;
  runtimeProvider: string | null | undefined;
  model: string | null | undefined;
  capacityConfigFingerprint?: string | null;
  unavailableReason?: ContextRuntimeIdentityUnavailableReason;
}

function normalizedComponent(value: string | null | undefined): string | null {
  const normalized = value?.trim() ?? '';
  return normalized.length > 0 && normalized.length <= MAX_IDENTITY_COMPONENT_LENGTH
    ? normalized
    : null;
}

export function contextRuntimeKey(input: {
  adapter: SessionAdapterId;
  runtimeProvider: string;
  model: string;
  capacityConfigFingerprint: string;
}): string {
  return JSON.stringify([
    'context-window-runtime',
    1,
    input.adapter,
    input.runtimeProvider,
    input.model,
    input.capacityConfigFingerprint,
  ]);
}

export function resolveContextRuntimeIdentity(
  input: ResolveContextRuntimeIdentityInput,
): ContextRuntimeIdentityResolution {
  if (input.unavailableReason) {
    return { status: 'unavailable', reason: input.unavailableReason };
  }
  const runtimeProvider = normalizedComponent(input.runtimeProvider);
  if (!runtimeProvider) {
    return { status: 'unavailable', reason: 'missing-runtime-provider' };
  }
  const model = normalizedComponent(input.model);
  if (!model) return { status: 'unavailable', reason: 'missing-model' };
  const capacityConfigFingerprint =
    normalizedComponent(input.capacityConfigFingerprint) ??
    DEFAULT_CAPACITY_CONFIG_FINGERPRINT;
  const identity = {
    version: 1 as const,
    adapter: input.adapter,
    runtimeProvider,
    model,
    capacityConfigFingerprint,
    runtimeKey: '',
  };
  identity.runtimeKey = contextRuntimeKey(identity);
  return { status: 'concrete', identity };
}

export function createContextRuntimeIdentity(
  input: Omit<ResolveContextRuntimeIdentityInput, 'unavailableReason'>,
): ContextRuntimeIdentity {
  const resolved = resolveContextRuntimeIdentity(input);
  if (resolved.status !== 'concrete') {
    throw new Error(`Context runtime identity is unavailable: ${resolved.reason}`);
  }
  return resolved.identity;
}

export function sameContextRuntimeIdentity(
  left: ContextRuntimeIdentity | null | undefined,
  right: ContextRuntimeIdentity | null | undefined,
): boolean {
  return left?.runtimeKey === right?.runtimeKey && left !== undefined && left !== null;
}
