import {
  isClaudeThinkingLevel,
  type ClaudeThinkingLevel,
} from '@shared/session-metadata';

const CLAUDE_ALIAS_MODEL_RE = /^(?:claude-)?(fable|opus|sonnet|haiku)(?:-|$)/i;

export interface ClaudeGatewayModelAliases {
  fable?: string;
  opus?: string;
  sonnet?: string;
  haiku?: string;
}

export interface ClaudeRuntimeMetadataOwner {
  applicationSid: string;
  runtimeModel?: string;
  runtimeEffort?: ClaudeThinkingLevel;
  gatewayModelAliases?: ClaudeGatewayModelAliases;
}

export interface ClaudeRuntimeMetadataRecord {
  model?: string | null;
  thinking?: unknown;
}

export type ClaudeRuntimeMetadataFailure = 'model' | 'effort' | 'hook';

export interface ClaudeRuntimeMetadataHost {
  read(sessionId: string): ClaudeRuntimeMetadataRecord | null;
  setModel(sessionId: string, model: string): void;
  setEffort(sessionId: string, effort: ClaudeThinkingLevel): void;
  emitUpdated(sessionId: string): void;
  warnFailure(
    kind: ClaudeRuntimeMetadataFailure,
    sessionId: string,
    error: unknown,
  ): void;
}

export function isClaudeRuntimeEffortCore(value: unknown): value is ClaudeThinkingLevel {
  return isClaudeThinkingLevel(value);
}

export function resolveClaudeRuntimeModelCore(
  reportedModel: unknown,
  gatewayModelAliases?: ClaudeGatewayModelAliases,
): string | null {
  if (typeof reportedModel !== 'string') return null;
  const trimmed = reportedModel.trim();
  if (!trimmed) return null;
  const match = CLAUDE_ALIAS_MODEL_RE.exec(trimmed);
  if (!match) return trimmed;
  const alias = match[1].toLowerCase() as keyof ClaudeGatewayModelAliases;
  return gatewayModelAliases?.[alias] ?? trimmed;
}

export function syncClaudeRuntimeModelCore(
  owner: ClaudeRuntimeMetadataOwner,
  reportedModel: unknown,
  host: ClaudeRuntimeMetadataHost,
): void {
  const model = resolveClaudeRuntimeModelCore(reportedModel, owner.gatewayModelAliases);
  if (!model) return;
  owner.runtimeModel = model;

  try {
    const current = host.read(owner.applicationSid);
    if (!current || current.model === model) return;
    host.setModel(owner.applicationSid, model);
    host.emitUpdated(owner.applicationSid);
  } catch (error) {
    warnWithoutThrow(host, 'model', owner.applicationSid, error);
  }
}

export function syncClaudeRuntimeEffortCore(
  owner: ClaudeRuntimeMetadataOwner,
  reportedEffort: unknown,
  host: ClaudeRuntimeMetadataHost,
): void {
  if (!isClaudeRuntimeEffortCore(reportedEffort)) return;
  owner.runtimeEffort = reportedEffort;

  try {
    const current = host.read(owner.applicationSid);
    if (!current || current.thinking === reportedEffort) return;
    host.setEffort(owner.applicationSid, reportedEffort);
    host.emitUpdated(owner.applicationSid);
  } catch (error) {
    warnWithoutThrow(host, 'effort', owner.applicationSid, error);
  }
}

export function warnClaudeRuntimeMetadataWithoutThrow(
  host: ClaudeRuntimeMetadataHost,
  kind: ClaudeRuntimeMetadataFailure,
  sessionId: string,
  error: unknown,
): void {
  warnWithoutThrow(host, kind, sessionId, error);
}

function warnWithoutThrow(
  host: ClaudeRuntimeMetadataHost,
  kind: ClaudeRuntimeMetadataFailure,
  sessionId: string,
  error: unknown,
): void {
  try {
    host.warnFailure(kind, sessionId, error);
  } catch {
    // Runtime metadata observation is best effort and cannot affect provider control flow.
  }
}
