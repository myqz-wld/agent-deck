import type { UploadedAttachmentInput } from '@shared/types';
import type { UploadedAttachmentEntry } from './types';

interface StoredPayload {
  base64: string;
  mime: string;
  bytes: number;
  disposePreview?: () => void;
}

const MAX_SIDECAR_BYTES = 128 * 1024 * 1024;
const MAX_SIDECAR_PAYLOADS = 128;

const payloadsBySession = new Map<string, Map<string, StoredPayload>>();
const aliases = new Map<string, string>();
let encodedBytes = 0;
let payloadCount = 0;

function resolveSessionId(sessionId: string): string {
  let current = sessionId;
  const visited = new Set<string>();
  while (aliases.has(current) && !visited.has(current)) {
    visited.add(current);
    current = aliases.get(current)!;
  }
  return current;
}

function disposePayload(payload: StoredPayload): void {
  encodedBytes -= payload.base64.length;
  payloadCount -= 1;
  payload.disposePreview?.();
}

export function storeAttachmentPayload(
  sessionId: string,
  attachmentId: string,
  payload: StoredPayload,
): boolean {
  const key = resolveSessionId(sessionId);
  const bucket = payloadsBySession.get(key) ?? new Map<string, StoredPayload>();
  const previous = bucket.get(attachmentId);
  const nextBytes = encodedBytes - (previous?.base64.length ?? 0) + payload.base64.length;
  const nextCount = payloadCount + (previous ? 0 : 1);
  if (nextBytes > MAX_SIDECAR_BYTES || nextCount > MAX_SIDECAR_PAYLOADS) return false;
  if (previous) disposePayload(previous);
  bucket.set(attachmentId, payload);
  payloadsBySession.set(key, bucket);
  encodedBytes += payload.base64.length;
  payloadCount += 1;
  return true;
}

export function attachmentInputs(
  sessionId: string,
  attachments: readonly UploadedAttachmentEntry[],
): UploadedAttachmentInput[] {
  const bucket = payloadsBySession.get(resolveSessionId(sessionId));
  return attachments.map((attachment) => {
    const payload = bucket?.get(attachment.id);
    if (!payload) throw new Error('图片内容已失效，请移除后重新添加');
    return {
      kind: 'image',
      base64: payload.base64,
      mime: payload.mime,
      bytes: payload.bytes,
    };
  });
}

export function attachmentPreviewDataUrl(sessionId: string, attachmentId: string): string | null {
  const payload = payloadsBySession.get(resolveSessionId(sessionId))?.get(attachmentId);
  return payload ? `data:${payload.mime};base64,${payload.base64}` : null;
}

export function releaseAttachmentPayloads(
  sessionId: string,
  attachmentIds: readonly string[],
): void {
  const key = resolveSessionId(sessionId);
  const bucket = payloadsBySession.get(key);
  if (!bucket) return;
  for (const id of attachmentIds) {
    const payload = bucket.get(id);
    if (!payload) continue;
    bucket.delete(id);
    disposePayload(payload);
  }
  if (bucket.size === 0) payloadsBySession.delete(key);
}

export function clearAttachmentPayloadSession(sessionId: string): void {
  const key = resolveSessionId(sessionId);
  const bucket = payloadsBySession.get(key);
  if (bucket) {
    for (const payload of bucket.values()) disposePayload(payload);
    payloadsBySession.delete(key);
  }
  for (const [from, to] of aliases) {
    if (from === sessionId || resolveSessionId(to) === key) aliases.delete(from);
  }
}

export function renameAttachmentPayloadSession(fromId: string, toId: string): void {
  const fromKey = resolveSessionId(fromId);
  const toKey = resolveSessionId(toId);
  if (fromKey !== toKey) {
    const source = payloadsBySession.get(fromKey);
    if (source) {
      const target = payloadsBySession.get(toKey) ?? new Map<string, StoredPayload>();
      for (const [id, payload] of source) {
        const duplicate = target.get(id);
        if (duplicate) disposePayload(payload);
        else target.set(id, payload);
      }
      payloadsBySession.delete(fromKey);
      if (target.size > 0) payloadsBySession.set(toKey, target);
    }
  }
  aliases.set(fromId, toKey);
  for (const [alias, target] of aliases) {
    if (target === fromId || target === fromKey) aliases.set(alias, toKey);
  }
}

export function imageAttachmentSidecarStats(): { bytes: number; payloads: number; sessions: number } {
  return { bytes: encodedBytes, payloads: payloadCount, sessions: payloadsBySession.size };
}

export function resetImageAttachmentSidecarForTests(): void {
  for (const bucket of payloadsBySession.values()) {
    for (const payload of bucket.values()) payload.disposePreview?.();
  }
  payloadsBySession.clear();
  aliases.clear();
  encodedBytes = 0;
  payloadCount = 0;
}
