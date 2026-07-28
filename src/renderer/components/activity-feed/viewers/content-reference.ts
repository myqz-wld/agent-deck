import type { DiffPayload, ImageSource } from '@shared/types';
import {
  createAuthorizedContentReferenceId,
  type ContentAnnotation,
  type DiffContentPayload,
  type DiffContentReference,
  type ImageContentPayload,
  type ImageContentReference,
  type StructuredContentValue,
  type ToolContentPayload,
} from '@renderer/components/expandable-content';

function opaqueId(parts: readonly (string | number)[]): string {
  return parts
    .map((part) => String(part).replace(/[^a-zA-Z0-9_.:-]/g, '_'))
    .join(':')
    .slice(0, 480);
}

export function toStructuredContentValue(value: unknown): StructuredContentValue {
  if (value === undefined) return null;
  try {
    const serialized = JSON.stringify(value);
    if (serialized === undefined) return String(value);
    return JSON.parse(serialized) as StructuredContentValue;
  } catch {
    return String(value);
  }
}

export function toolPayload(input: {
  toolName: string;
  toolInput: unknown;
  resultStatus: NonNullable<ToolContentPayload['result']>['status'];
  resultValue?: unknown;
  resultText?: string;
  statusLabel?: string;
  statusDetail?: string | null;
  duration?: string | null;
  truncation?: string | null;
  reason?: string | null;
  failure?: string | null;
}): ToolContentPayload {
  return {
    kind: 'tool',
    toolName: input.toolName,
    input: toStructuredContentValue(input.toolInput),
    result: {
      status: input.resultStatus,
      ...(input.resultValue === undefined
        ? {}
        : { value: toStructuredContentValue(input.resultValue) }),
      ...(input.resultText === undefined ? {} : { text: input.resultText }),
    },
    metadata: {
      ...(input.statusLabel ? { status: input.statusLabel } : {}),
      ...(input.statusDetail ? { statusDetail: input.statusDetail } : {}),
      ...(input.duration ? { duration: input.duration } : {}),
      ...(input.truncation ? { truncation: input.truncation } : {}),
      ...(input.reason ? { reason: input.reason } : {}),
      ...(input.failure ? { failure: input.failure } : {}),
    },
  };
}

function annotationsFromMetadata(metadata: Record<string, unknown> | undefined): ContentAnnotation[] {
  const raw = metadata?.annotations;
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((value, index) => {
    if (!value || typeof value !== 'object') return [];
    const item = value as Record<string, unknown>;
    if (typeof item.text !== 'string') return [];
    return [{
      id: typeof item.id === 'string' ? item.id : `annotation-${index}`,
      text: item.text,
      ...(typeof item.start === 'number' ? { start: item.start } : {}),
      ...(typeof item.end === 'number' ? { end: item.end } : {}),
      ...(typeof item.author === 'string' ? { author: item.author } : {}),
      ...(item.status === 'open' || item.status === 'resolved' ? { status: item.status } : {}),
    }];
  });
}

export interface LocalDiffContent {
  payload: DiffContentPayload;
  resolve: (reference: DiffContentReference) => DiffPayload | null;
}

export interface LocalImageContent {
  payload: ImageContentPayload;
  resolve: (reference: ImageContentReference) => ImageSource | null;
}

/**
 * Required diff/image references are resolved only by the owning heavy-view closure. The grant
 * identifies that process-local resolver; it is not an external authorization claim.
 */
export function localDiffContent(input: {
  sessionId: string;
  eventId: string;
  toolName: string;
  diff: DiffPayload;
  statusLabel?: string;
  truncation?: string | null;
}): LocalDiffContent {
  const referenceId = createAuthorizedContentReferenceId(
    opaqueId(['local-diff', input.sessionId, input.eventId]),
  );
  const grantId = opaqueId(['local-heavy-view', input.sessionId, input.eventId]);
  const reference: DiffContentReference = {
    kind: 'diff',
    referenceId,
    authorization: {
      sessionId: input.sessionId,
      grantId,
      capability: 'read-diff',
    },
    presentation: input.diff.kind === 'image' ? 'image-diff' : 'text-diff',
    beforeLabel: '修改前',
    afterLabel: '修改后',
  };
  const payload: DiffContentPayload = {
    kind: 'diff',
    reference,
    annotations: annotationsFromMetadata(input.diff.metadata),
    metadata: {
      tool: input.toolName,
      file: input.diff.filePath,
      ...(input.statusLabel ? { status: input.statusLabel } : {}),
      ...(input.truncation ? { truncation: input.truncation } : {}),
    },
  };
  return {
    payload,
    resolve: (candidate) => (
      candidate.referenceId === referenceId
      && candidate.authorization.sessionId === input.sessionId
      && candidate.authorization.grantId === grantId
      && candidate.authorization.capability === 'read-diff'
        ? input.diff
        : null
    ),
  };
}

export function localImageContent(input: {
  sessionId: string;
  eventId: string;
  source: ImageSource;
  alt: string;
  mediaType?: string;
  width?: number;
  height?: number;
  description?: string;
  provider?: string;
  model?: string;
}): LocalImageContent {
  const referenceId = createAuthorizedContentReferenceId(
    opaqueId(['local-image', input.sessionId, input.eventId]),
  );
  const grantId = opaqueId(['local-heavy-view', input.sessionId, input.eventId]);
  const reference: ImageContentReference = {
    kind: 'image',
    referenceId,
    authorization: {
      sessionId: input.sessionId,
      grantId,
      capability: 'read-image',
    },
    mediaType: input.mediaType ?? 'image/*',
    alt: input.alt,
    ...(input.width === undefined ? {} : { width: input.width }),
    ...(input.height === undefined ? {} : { height: input.height }),
  };
  const payload: ImageContentPayload = {
    kind: 'image',
    reference,
    metadata: {
      sourceKind: input.source.kind,
      ...(input.description ? { description: input.description } : {}),
      ...(input.provider ? { provider: input.provider } : {}),
      ...(input.model ? { model: input.model } : {}),
    },
  };
  return {
    payload,
    resolve: (candidate) => (
      candidate.referenceId === referenceId
      && candidate.authorization.sessionId === input.sessionId
      && candidate.authorization.grantId === grantId
      && candidate.authorization.capability === 'read-image'
        ? input.source
        : null
    ),
  };
}
