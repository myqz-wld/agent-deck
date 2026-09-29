import { EVENT_IMAGE_ID, eventImages } from '@shared/event-images';
import { getDb } from './db';
import { loadStoredEventImage, type StoredEventImage } from './event-image-files';
import type { LoadImageBlobResult } from '@shared/types';
import { legacyEventImage, legacyImageEventId } from './legacy-event-image';

export function findEventImage(sessionId: string, imageId: string): StoredEventImage | null {
  if (!sessionId || !EVENT_IMAGE_ID.test(imageId)) return null;
  const row = getDb().prepare(`
    SELECT image.value AS image_json FROM events e,
      json_each(CASE WHEN json_valid(e.payload_json) THEN json_extract(e.payload_json, '$.images') END) image
    WHERE e.session_id = ? AND CASE WHEN image.type = 'object' THEN json_extract(image.value, '$.id') END = ? LIMIT 1
  `).get(sessionId, imageId) as { image_json: string } | undefined;
  if (!row) {
    const eventId = legacyImageEventId(imageId);
    if (eventId === null) return null;
    const old = getDb().prepare('SELECT payload_json FROM events WHERE id = ? AND session_id = ?')
      .get(eventId, sessionId) as { payload_json: string } | undefined;
    try { return old ? legacyEventImage(JSON.parse(old.payload_json), eventId) : null; }
    catch { return null; }
  }
  try {
    const image = JSON.parse(row.image_json) as StoredEventImage;
    if (!eventImages({ images: [image] }).length) return null;
    if (image.source?.kind === 'stored' ||
        (image.source?.kind === 'path' && typeof image.source.path === 'string')) return image;
  } catch { /* A damaged event cannot authorize a file read. */ }
  return null;
}
export async function loadEventImage(
  sessionId: string, imageId: string, workspaceRoot?: string, pathAllowed?: (path: string) => boolean,
): Promise<LoadImageBlobResult> {
  const image = findEventImage(sessionId, imageId);
  if (image?.source.kind === 'path' && pathAllowed && !pathAllowed(image.source.path)) {
    return { ok: false, reason: 'denied' };
  }
  return image ? loadStoredEventImage(image, workspaceRoot, pathAllowed) : { ok: false, reason: 'denied' };
}
