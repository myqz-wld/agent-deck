/** Event history carries references, never inline image bytes. */
export interface EventImageRef {
  id: string;
  mime: string;
  bytes?: number;
  name: string;
}
export const EVENT_IMAGE_ID = /^[a-f0-9]{64}$/;
export const EVENT_IMAGE_MAX_BYTES = 16 * 1024 * 1024;
export const EVENT_IMAGE_MAX_COUNT = 8;

export function eventImages(payload: unknown): EventImageRef[] {
  if (!payload || typeof payload !== 'object') return [];
  const images = (payload as { images?: unknown }).images;
  if (!Array.isArray(images)) return [];
  return images.filter((image): image is EventImageRef => Boolean(
    image && typeof image === 'object' && typeof image.id === 'string' && EVENT_IMAGE_ID.test(image.id) &&
    typeof image.mime === 'string' && typeof image.name === 'string',
  )).slice(0, EVENT_IMAGE_MAX_COUNT);
}
export type SaveImageResult =
  | { ok: true }
  | { ok: false; reason: 'cancelled' | 'invalid_image' | 'io_error' };
