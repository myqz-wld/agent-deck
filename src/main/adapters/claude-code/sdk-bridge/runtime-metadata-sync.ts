import type { HookCallback, Options } from '@anthropic-ai/claude-agent-sdk';
import type { ClaudeCodeEffortLevel } from '@main/adapters/types';
import {
  isClaudeRuntimeEffortCore,
  resolveClaudeRuntimeModelCore,
  syncClaudeRuntimeEffortCore,
  syncClaudeRuntimeModelCore,
  warnClaudeRuntimeMetadataWithoutThrow,
} from './runtime-metadata-core';
import { desktopClaudeRuntimeMetadataHost } from './runtime-metadata-host';
import type { ClaudeGatewayModelAliases, InternalSession } from './types';

export function isClaudeRuntimeEffort(value: unknown): value is ClaudeCodeEffortLevel {
  return isClaudeRuntimeEffortCore(value);
}

export function resolveClaudeRuntimeModel(
  reportedModel: unknown,
  gatewayModelAliases?: ClaudeGatewayModelAliases,
): string | null {
  return resolveClaudeRuntimeModelCore(reportedModel, gatewayModelAliases);
}

export function syncClaudeRuntimeModel(
  internal: InternalSession,
  reportedModel: unknown,
): void {
  syncClaudeRuntimeModelCore(internal, reportedModel, desktopClaudeRuntimeMetadataHost);
}

export function syncClaudeRuntimeEffort(
  internal: InternalSession,
  reportedEffort: unknown,
): void {
  syncClaudeRuntimeEffortCore(internal, reportedEffort, desktopClaudeRuntimeMetadataHost);
}

export function buildClaudeRuntimeMetadataHooks(
  internal: InternalSession,
): NonNullable<Options['hooks']> {
  const captureEffort: HookCallback = async (input) => {
    try {
      if (
        input.agent_id === undefined
        && (input.hook_event_name === 'Stop' || input.hook_event_name === 'StopFailure')
      ) {
        syncClaudeRuntimeEffort(internal, input.effort?.level);
      }
    } catch (error) {
      warnClaudeRuntimeMetadataWithoutThrow(
        desktopClaudeRuntimeMetadataHost,
        'hook',
        internal.applicationSid,
        error,
      );
    }
    return {};
  };

  return {
    Stop: [{ hooks: [captureEffort] }],
    StopFailure: [{ hooks: [captureEffort] }],
  };
}
