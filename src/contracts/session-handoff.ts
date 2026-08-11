import { isJsonObject } from './json';
import {
  parseSessionConsoleCreateOptions,
  type SessionConsoleCreateOptions,
} from './session-console-capabilities';
import {
  parseSessionConsoleInitialMessage,
} from './session-console';
import { parseWorkspaceDirectoryRef } from './session-console-common';

const TOKEN = /^[A-Za-z0-9][A-Za-z0-9._:@-]*$/;
const DIGEST = /^sha256:[0-9a-f]{64}$/;
const ADAPTERS = new Set(['claude-code', 'codex-cli', 'grok-build']);
const QUALITIES = new Set([
  'full', 'projected', 'coverage-gap', 'raw-only', 'instruction-only',
]);
const MAX_PREVIEW_BYTES = 32 * 1024;
const MAX_WARNINGS = 64;

export interface SessionHandOffTargetDto {
  adapterId: 'claude-code' | 'codex-cli' | 'grok-build';
  workingDirectory: string;
  capabilityRevision: string;
  options: SessionConsoleCreateOptions;
}

export interface SessionHandOffTargetInputDto
  extends Omit<SessionHandOffTargetDto, 'capabilityRevision' | 'workingDirectory'> {
  /** Null inherits the source session's Worker-relative directory. */
  workingDirectory: string | null;
  /** Null delegates the inherited-directory capability snapshot to the authoritative Core. */
  capabilityRevision: string | null;
}

export interface SessionHandOffPreviewParams {
  sessionId: string;
  continuationInstruction: string;
  target: SessionHandOffTargetInputDto;
}

export interface SessionHandOffCommitParams extends SessionHandOffPreviewParams {
  expectedBindingDigest: string;
}

export interface SessionHandOffPreviewResult {
  bindingDigest: string;
  preview: string;
  previewTruncated: boolean;
  quality: 'full' | 'projected' | 'coverage-gap' | 'raw-only' | 'instruction-only';
  source: { eventRevision: number; rebuildAfterRevision: number };
  checkpoint: {
    id: number | null;
    throughRevision: number;
    formatVersion: number;
    refreshed: boolean;
  };
  metrics: {
    estimatedPromptTokens: number;
    checkpointTokens: number;
    rawTailTokens: number;
    includedUserMessages: number;
    truncatedBoundaryMessages: number;
    rawRetentionCeilingTokens: number;
    elapsedMs: number;
  };
  warnings: Array<{ code: string; message: string }>;
  target: SessionHandOffTargetDto;
  revision: number;
}

export interface SessionHandOffCommitResult {
  successorSessionId: string;
  cutoverEventRevision: number;
  lateMessagesDelivered: number;
  usedLowerBudgetRetry: boolean;
  sourceFinalizationWarning: string | null;
  revision: number;
}

export class SessionHandOffContractError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SessionHandOffContractError';
  }
}

function object(value: unknown, label: string): Record<string, unknown> {
  if (!isJsonObject(value)) throw new SessionHandOffContractError(`${label} is invalid`);
  return value;
}

function exact(
  value: Record<string, unknown>,
  required: readonly string[],
  optional: readonly string[] = [],
): void {
  const keys = Object.keys(value);
  const allowed = new Set([...required, ...optional]);
  if (required.some((key) => !(key in value)) || keys.some((key) => !allowed.has(key))) {
    throw new SessionHandOffContractError('handoff fields are invalid');
  }
}

function token(value: unknown, label: string): string {
  if (
    typeof value !== 'string' || value.length === 0 ||
    Buffer.byteLength(value) > 256 || !TOKEN.test(value)
  ) throw new SessionHandOffContractError(`${label} is invalid`);
  return value;
}

function digest(value: unknown): string {
  if (typeof value !== 'string' || !DIGEST.test(value)) {
    throw new SessionHandOffContractError('handoff digest is invalid');
  }
  return value;
}

function count(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || Number(value) < 0) {
    throw new SessionHandOffContractError(`${label} is invalid`);
  }
  return Number(value);
}

function target(value: unknown, allowInheritedDirectory: false): SessionHandOffTargetDto;
function target(value: unknown, allowInheritedDirectory: true): SessionHandOffTargetInputDto;
function target(
  value: unknown,
  allowInheritedDirectory: boolean,
): SessionHandOffTargetDto | SessionHandOffTargetInputDto {
  const raw = object(value, 'handoff target');
  exact(raw, ['adapterId', 'capabilityRevision', 'options', 'workingDirectory']);
  if (typeof raw.adapterId !== 'string' || !ADAPTERS.has(raw.adapterId)) {
    throw new SessionHandOffContractError('handoff adapter is invalid');
  }
  let options: SessionConsoleCreateOptions;
  try {
    options = parseSessionConsoleCreateOptions(raw.options);
  } catch (error) {
    throw new SessionHandOffContractError(
      error instanceof Error ? error.message : 'handoff options are invalid',
    );
  }
  const inheritedDirectory = allowInheritedDirectory && raw.workingDirectory === null;
  if (inheritedDirectory && raw.capabilityRevision !== null) {
    throw new SessionHandOffContractError(
      'inherited handoff directory requires a Core-owned capability revision',
    );
  }
  return {
    adapterId: raw.adapterId as SessionHandOffTargetDto['adapterId'],
    capabilityRevision: inheritedDirectory
      ? null
      : token(raw.capabilityRevision, 'handoff capability revision'),
    workingDirectory: inheritedDirectory
      ? null
      : parseWorkspaceDirectoryRef(raw.workingDirectory, 'handoff workingDirectory'),
    options,
  };
}

export function parseSessionHandOffPreviewParams(value: unknown): SessionHandOffPreviewParams {
  const raw = object(value, 'handoff preview params');
  exact(raw, ['continuationInstruction', 'sessionId', 'target']);
  return {
    sessionId: token(raw.sessionId, 'handoff session id'),
    continuationInstruction: parseSessionConsoleInitialMessage(
      raw.continuationInstruction,
      'handoff continuationInstruction',
    ),
    target: target(raw.target, true),
  };
}

export function parseSessionHandOffCommitParams(value: unknown): SessionHandOffCommitParams {
  const raw = object(value, 'handoff commit params');
  exact(raw, [
    'continuationInstruction', 'expectedBindingDigest', 'sessionId', 'target',
  ]);
  const preview = parseSessionHandOffPreviewParams({
    continuationInstruction: raw.continuationInstruction,
    sessionId: raw.sessionId,
    target: raw.target,
  });
  return { ...preview, expectedBindingDigest: digest(raw.expectedBindingDigest) };
}

function parseTargetResult(value: unknown): SessionHandOffTargetDto {
  return target(value, false);
}

export function parseSessionHandOffPreviewResult(value: unknown): SessionHandOffPreviewResult {
  const raw = object(value, 'handoff preview result');
  exact(raw, [
    'bindingDigest', 'checkpoint', 'metrics', 'preview', 'previewTruncated', 'quality',
    'revision', 'source', 'target', 'warnings',
  ]);
  if (
    typeof raw.preview !== 'string' || Buffer.byteLength(raw.preview) > MAX_PREVIEW_BYTES ||
    typeof raw.previewTruncated !== 'boolean' ||
    typeof raw.quality !== 'string' || !QUALITIES.has(raw.quality) ||
    !Array.isArray(raw.warnings) || raw.warnings.length > MAX_WARNINGS
  ) throw new SessionHandOffContractError('handoff preview result fields are invalid');
  const source = object(raw.source, 'handoff source');
  exact(source, ['eventRevision', 'rebuildAfterRevision']);
  const checkpoint = object(raw.checkpoint, 'handoff checkpoint');
  exact(checkpoint, ['formatVersion', 'id', 'refreshed', 'throughRevision']);
  if (
    checkpoint.id !== null && (!Number.isSafeInteger(checkpoint.id) || Number(checkpoint.id) <= 0)
  ) throw new SessionHandOffContractError('handoff checkpoint id is invalid');
  if (typeof checkpoint.refreshed !== 'boolean') {
    throw new SessionHandOffContractError('handoff checkpoint refresh flag is invalid');
  }
  const metrics = object(raw.metrics, 'handoff metrics');
  const metricKeys = [
    'checkpointTokens', 'elapsedMs', 'estimatedPromptTokens', 'includedUserMessages',
    'rawRetentionCeilingTokens', 'rawTailTokens', 'truncatedBoundaryMessages',
  ];
  exact(metrics, metricKeys);
  const parsedMetrics = Object.fromEntries(metricKeys.map((key) => [
    key, count(metrics[key], `handoff metrics.${key}`),
  ])) as unknown as SessionHandOffPreviewResult['metrics'];
  const warnings = raw.warnings.map((entry, index) => {
    const warning = object(entry, `handoff warning ${index}`);
    exact(warning, ['code', 'message']);
    return {
      code: token(warning.code, `handoff warning ${index} code`),
      message: typeof warning.message === 'string' && Buffer.byteLength(warning.message) <= 1_024
        ? warning.message
        : (() => { throw new SessionHandOffContractError('handoff warning is invalid'); })(),
    };
  });
  return {
    bindingDigest: digest(raw.bindingDigest),
    preview: raw.preview,
    previewTruncated: raw.previewTruncated,
    quality: raw.quality as SessionHandOffPreviewResult['quality'],
    source: {
      eventRevision: count(source.eventRevision, 'handoff source eventRevision'),
      rebuildAfterRevision: count(
        source.rebuildAfterRevision,
        'handoff source rebuildAfterRevision',
      ),
    },
    checkpoint: {
      id: checkpoint.id === null ? null : Number(checkpoint.id),
      throughRevision: count(checkpoint.throughRevision, 'handoff checkpoint revision'),
      formatVersion: count(checkpoint.formatVersion, 'handoff checkpoint format'),
      refreshed: checkpoint.refreshed,
    },
    metrics: parsedMetrics,
    warnings,
    target: parseTargetResult(raw.target),
    revision: count(raw.revision, 'handoff revision'),
  };
}

export function parseSessionHandOffCommitResult(value: unknown): SessionHandOffCommitResult {
  const raw = object(value, 'handoff commit result');
  exact(raw, [
    'cutoverEventRevision', 'lateMessagesDelivered', 'revision',
    'sourceFinalizationWarning', 'successorSessionId', 'usedLowerBudgetRetry',
  ]);
  if (
    typeof raw.usedLowerBudgetRetry !== 'boolean' ||
    (raw.sourceFinalizationWarning !== null && (
      typeof raw.sourceFinalizationWarning !== 'string' ||
      Buffer.byteLength(raw.sourceFinalizationWarning) > 1_024
    ))
  ) throw new SessionHandOffContractError('handoff commit result fields are invalid');
  return {
    successorSessionId: token(raw.successorSessionId, 'handoff successor session id'),
    cutoverEventRevision: count(raw.cutoverEventRevision, 'handoff cutover revision'),
    lateMessagesDelivered: count(raw.lateMessagesDelivered, 'handoff late messages'),
    usedLowerBudgetRetry: raw.usedLowerBudgetRetry,
    sourceFinalizationWarning: raw.sourceFinalizationWarning,
    revision: count(raw.revision, 'handoff revision'),
  };
}
