import { resolveClaudeGatewayProfile } from '@main/adapters/claude-code/gateway-profiles';
import { settingsStore } from '@main/store/settings-store';
import type { ResolvedContinuationGenerator } from './types';
import {
  resolveContinuationGeneratorConfigFingerprintFromSettings,
  resolveContinuationGeneratorSnapshotFromSettings,
  resolveContinuationRawRetentionCeilingFromValue,
  type ContinuationCapacityResolutionDependencies,
  type ContinuationGeneratorSettings,
} from './resolver-core';

export * from './resolver-core';

function desktopGeneratorSettings(): ContinuationGeneratorSettings {
  return {
    continuationCheckpointAdapter: settingsStore.get('continuationCheckpointAdapter'),
    continuationCheckpointRuntimeProvider:
      settingsStore.get('continuationCheckpointRuntimeProvider'),
    continuationCheckpointModel: settingsStore.get('continuationCheckpointModel'),
    continuationCheckpointThinking: settingsStore.get('continuationCheckpointThinking'),
    resolveClaudeGatewayProfile: (provider) => resolveClaudeGatewayProfile(provider),
  };
}

export function resolveContinuationGeneratorConfigFingerprint(): string {
  return resolveContinuationGeneratorConfigFingerprintFromSettings(desktopGeneratorSettings());
}

export function resolveContinuationGeneratorSnapshot(
  dependencies: ContinuationCapacityResolutionDependencies = {},
): ResolvedContinuationGenerator {
  return resolveContinuationGeneratorSnapshotFromSettings(
    desktopGeneratorSettings(),
    dependencies,
  );
}

export function resolveContinuationRawRetentionCeiling(): number {
  return resolveContinuationRawRetentionCeilingFromValue(
    settingsStore.get('continuationRawRetentionTokens'),
  );
}
