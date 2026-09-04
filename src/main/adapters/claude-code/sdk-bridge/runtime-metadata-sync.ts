import type { HookCallback, Options } from '@anthropic-ai/claude-agent-sdk';
import {
  syncClaudeRuntimeEffortCore,
  warnClaudeRuntimeMetadataWithoutThrow,
} from './runtime-metadata-core';
import { desktopClaudeRuntimeMetadataHost } from './runtime-metadata-host';
import type { InternalSession } from './types';

function syncClaudeRuntimeEffort(
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
