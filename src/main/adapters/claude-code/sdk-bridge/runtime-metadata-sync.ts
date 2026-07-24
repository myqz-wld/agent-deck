import type { HookCallback, Options } from '@anthropic-ai/claude-agent-sdk';
import type { ClaudeCodeEffortLevel } from '@main/adapters/types';
import { eventBus } from '@main/event-bus';
import { sessionRepo } from '@main/store/session-repo';
import log from '@main/utils/logger';
import { isClaudeThinkingLevel } from '@shared/session-metadata';
import type { ClaudeProviderModelAliases, InternalSession } from './types';

const logger = log.scope('claude-runtime-metadata');
const CLAUDE_ALIAS_MODEL_RE = /^(?:claude-)?(fable|opus|sonnet|haiku)(?:-|$)/i;

export function isClaudeRuntimeEffort(value: unknown): value is ClaudeCodeEffortLevel {
  return isClaudeThinkingLevel(value);
}

function resolveRuntimeModel(internal: InternalSession, reportedModel: unknown): string | null {
  if (typeof reportedModel !== 'string') return null;
  const trimmed = reportedModel.trim();
  if (!trimmed) return null;
  const match = CLAUDE_ALIAS_MODEL_RE.exec(trimmed);
  if (!match) return trimmed;
  const alias = match[1].toLowerCase() as keyof ClaudeProviderModelAliases;
  return internal.providerModelAliases?.[alias] ?? trimmed;
}

function emitUpdatedSession(internal: InternalSession): void {
  const updated = sessionRepo.get(internal.applicationSid);
  if (updated) eventBus.emit('session-upserted', updated);
}

export function syncClaudeRuntimeModel(
  internal: InternalSession,
  reportedModel: unknown,
): void {
  const model = resolveRuntimeModel(internal, reportedModel);
  if (!model) return;
  internal.runtimeModel = model;

  try {
    const current = sessionRepo.get(internal.applicationSid);
    if (!current || current.model === model) return;
    sessionRepo.setModel(internal.applicationSid, model);
    emitUpdatedSession(internal);
  } catch (err) {
    logger.warn(
      `[claude-bridge] runtime model sync failed for ${internal.applicationSid}`,
      err,
    );
  }
}

export function syncClaudeRuntimeEffort(
  internal: InternalSession,
  reportedEffort: unknown,
): void {
  if (!isClaudeRuntimeEffort(reportedEffort)) return;
  internal.runtimeEffort = reportedEffort;

  try {
    const current = sessionRepo.get(internal.applicationSid);
    if (!current || current.thinking === reportedEffort) return;
    sessionRepo.setThinking(internal.applicationSid, reportedEffort);
    emitUpdatedSession(internal);
  } catch (err) {
    logger.warn(
      `[claude-bridge] runtime effort sync failed for ${internal.applicationSid}`,
      err,
    );
  }
}

export function buildClaudeRuntimeMetadataHooks(
  internal: InternalSession,
): NonNullable<Options['hooks']> {
  const captureEffort: HookCallback = async (input) => {
    try {
      if (
        input.agent_id === undefined &&
        (input.hook_event_name === 'Stop' || input.hook_event_name === 'StopFailure')
      ) {
        syncClaudeRuntimeEffort(internal, input.effort?.level);
      }
    } catch (err) {
      // Metadata observation must never change whether Claude is allowed to stop.
      logger.warn(
        `[claude-bridge] runtime effort hook failed for ${internal.applicationSid}`,
        err,
      );
    }
    return {};
  };

  return {
    Stop: [{ hooks: [captureEffort] }],
    StopFailure: [{ hooks: [captureEffort] }],
  };
}
