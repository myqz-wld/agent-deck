import type { SessionHandOffPreparation } from '@shared/types';
import type { CachedContinuationPreparation } from '../continuation-context/preparation-cache';
import {
  estimateContinuationTokens,
  utf8ByteLength,
} from '../continuation-context/token-estimator';

export const UI_CONTINUATION_PREVIEW_MAX_BYTES = 32 * 1024;
export const UI_CONTINUATION_PREVIEW_MAX_TOKENS = 8_000;

function prefixAtBoundary(bytes: Buffer, length: number): Buffer {
  let end = Math.min(bytes.length, Math.max(0, length));
  while (end > 0 && end < bytes.length && (bytes[end] & 0xc0) === 0x80) end -= 1;
  return bytes.subarray(0, end);
}

function suffixAtBoundary(bytes: Buffer, length: number): Buffer {
  let start = Math.max(0, bytes.length - Math.max(0, length));
  while (start < bytes.length && (bytes[start] & 0xc0) === 0x80) start += 1;
  return bytes.subarray(start);
}

/** Keep both provenance at the front and the authoritative instruction at the end. */
export function boundedContinuationPreview(text: string): {
  preview: string;
  truncated: boolean;
} {
  if (
    utf8ByteLength(text) <= UI_CONTINUATION_PREVIEW_MAX_BYTES &&
    estimateContinuationTokens(text) <= UI_CONTINUATION_PREVIEW_MAX_TOKENS
  ) {
    return { preview: text, truncated: false };
  }
  const bytes = Buffer.from(text, 'utf8');
  const marker = Buffer.from('\n…[续接上下文预览已截断；完整内容仅保留在主进程]\n', 'utf8');
  let retainedBytes = Math.min(
    UI_CONTINUATION_PREVIEW_MAX_BYTES - marker.length,
    Math.floor((UI_CONTINUATION_PREVIEW_MAX_TOKENS * 4) / 1.15) - marker.length,
  );
  for (;;) {
    const prefix = prefixAtBoundary(bytes, Math.ceil(retainedBytes / 2));
    const suffix = suffixAtBoundary(bytes, Math.floor(retainedBytes / 2));
    const preview = `${prefix.toString('utf8')}${marker.toString('utf8')}${suffix.toString('utf8')}`;
    if (
      utf8ByteLength(preview) <= UI_CONTINUATION_PREVIEW_MAX_BYTES &&
      estimateContinuationTokens(preview) <= UI_CONTINUATION_PREVIEW_MAX_TOKENS
    ) {
      return { preview, truncated: true };
    }
    retainedBytes -= 128;
    if (retainedBytes <= 0) throw new Error('无法在预览预算内生成截断标记');
  }
}

export function publicHandOffPreparation(
  entry: CachedContinuationPreparation,
): SessionHandOffPreparation {
  const bounded = boundedContinuationPreview(entry.prepared.providerPrompt);
  return {
    preparationId: entry.preparationId,
    preview: bounded.preview,
    previewTruncated: bounded.truncated,
    quality: entry.prepared.quality,
    source: {
      eventRevision: entry.prepared.source.eventRevision,
      rebuildAfterRevision: entry.prepared.source.rebuildAfterRevision,
    },
    checkpoint: { ...entry.prepared.checkpoint },
    metrics: {
      estimatedPromptTokens: entry.prepared.metrics.estimatedPromptTokens,
      checkpointTokens: entry.prepared.metrics.checkpointTokens,
      rawTailTokens: entry.prepared.metrics.rawTailTokens,
      includedUserMessages: entry.prepared.metrics.includedUserMessages,
      truncatedBoundaryMessages: entry.prepared.metrics.truncatedBoundaryMessages,
      rawRetentionCeilingTokens: entry.prepared.metrics.rawRetentionCeilingTokens,
      elapsedMs: entry.prepared.metrics.elapsedMs,
    },
    warnings: entry.prepared.warnings.map(({ code, message }) => ({ code, message })),
    target: {
      adapter: entry.target.adapter,
      provider: entry.target.provider ?? null,
      model: entry.target.model,
      thinking: entry.target.thinking,
      sessionMode: entry.target.sessionMode ?? null,
    },
  };
}
