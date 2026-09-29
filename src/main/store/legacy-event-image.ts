import { isAbsolute } from 'node:path';
import { referenceEventImagePath, type StoredEventImage } from './event-image-files';

const PREFIX = 'ffffffffffffffffffffffffffffffff';

/** Old Codex records may retain a saved file path even though inline bytes were discarded. */
export function legacyEventImage(payload: unknown, eventId: number): StoredEventImage | null {
  if (!payload || typeof payload !== 'object' || !Number.isSafeInteger(eventId) || eventId <= 0) return null;
  const value = payload as Record<string, unknown>;
  if (Array.isArray(value.images) && value.images.length) return null;
  const result = value.toolResult as { savedPath?: unknown; path?: unknown } | null;
  const path = value.toolName === 'ImageGeneration' ? result?.savedPath
    : value.toolName === 'ImageView' ? result?.path : null;
  if (typeof path !== 'string' || !isAbsolute(path)) return null;
  try {
    return { ...referenceEventImagePath(path, ''), id: `${PREFIX}${eventId.toString(16).padStart(32, '0')}` };
  } catch { return null; }
}

export function legacyImageEventId(imageId: string): number | null {
  if (!/^[a-f0-9]{64}$/.test(imageId) || !imageId.startsWith(PREFIX)) return null;
  const value = Number.parseInt(imageId.slice(PREFIX.length), 16);
  return Number.isSafeInteger(value) && value > 0 ? value : null;
}
