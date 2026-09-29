import type { AgentEvent } from '@shared/types';
import { EVENT_IMAGE_MAX_COUNT } from '@shared/event-images';
import { persistInlineEventImage, referenceEventImagePath, type StoredEventImage } from '@main/store/event-image-files';

type RecordValue = Record<string, unknown>;
function record(value: unknown): RecordValue | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as RecordValue : null;
}

/** Extract explicit provider image blocks before event truncation and IPC fan-out. */
export function prepareEventImages(event: AgentEvent, cwd: string): AgentEvent {
  if (event.kind !== 'message' && event.kind !== 'tool-use-start' && event.kind !== 'tool-use-end') return event;
  const payload = record(event.payload);
  if (!payload || payload.role === 'user') return event;
  const images: StoredEventImage[] = [];
  const warnings: string[] = [];
  let changed = false;
  let visited = 0;
  const save = (input: RecordValue): RecordValue => {
    changed = true;
    if (images.length >= EVENT_IMAGE_MAX_COUNT) {
      warnings.push('单条记录最多展示 8 张图片');
      return { type: 'image', unavailable: true };
    }
    try {
      const source = record(input.source);
      const file = record(input.file);
      const data = input.data ?? input.base64 ?? source?.data ?? file?.base64 ?? input.imageUrl ?? input.image_url ?? input.url;
      const mime = input.mimeType ?? input.mime ?? source?.media_type ?? file?.mimeType ?? file?.mime;
      let image: StoredEventImage | null;
      try {
        image = input.kind === 'path' && typeof input.path === 'string'
          ? referenceEventImagePath(input.path, cwd)
          : typeof data === 'string'
            ? persistInlineEventImage(data, typeof mime === 'string' ? mime : undefined)
            : null;
      } catch (error) {
        if (typeof input.fallbackPath !== 'string') throw error;
        image = referenceEventImagePath(input.fallbackPath, cwd);
      }
      if (!image) throw new Error('未收到可读取的图片数据');
      if (!images.some((existing) => existing.id === image.id)) images.push(image);
      return { type: 'image', imageId: image.id, mime: image.mime, bytes: image.bytes };
    } catch (error) {
      warnings.push(error instanceof Error ? error.message : '图片保存失败');
      return { type: 'image', unavailable: true };
    }
  };
  const visit = (value: unknown, depth = 0): unknown => {
    if (++visited > 4096 || depth > 8) {
      changed = true;
      return '[内容过深或过多，已省略]';
    }
    if (Array.isArray(value)) return value.map((item) => visit(item, depth + 1));
    const item = record(value);
    if (!item) return value;
    if (item.type === 'image' || item.type === 'image_url' || item.type === 'input_image' || item.type === 'inputImage' ||
        (typeof item.image_url === 'string' && item.image_url.startsWith('data:image/'))) {
      const nested = record(item.image_url);
      return save(nested ? { ...item, image_url: nested.url } : item);
    }
    const result = { ...item };
    for (const key of ['content', 'contentItems', 'result', 'output']) {
      if (key in result) result[key] = visit(result[key], depth + 1);
    }
    return result;
  };
  const next = { ...payload };
  for (const key of ['toolResult', 'toolResponse', 'content']) {
    if (key in next) next[key] = visit(next[key]);
  }
  if (Array.isArray(payload.imageInputs)) {
    for (const input of payload.imageInputs) {
      const value = record(input);
      if (value) save(value);
    }
    delete next.imageInputs;
    changed = true;
  }
  if (!images.length && !Array.isArray(payload.imageInputs) &&
      typeof payload.toolName === 'string' && /image|screenshot/i.test(payload.toolName)) {
    const result = record(payload.toolResult ?? payload.toolResponse);
    const path = result?.savedPath ?? result?.image_path ?? result?.path;
    if (typeof path === 'string') save({ kind: 'path', path });
  }
  if (!changed) return event;
  if (images.length || Array.isArray(payload.imageInputs)) next.images = images;
  if (warnings.length) next.imageWarnings = [...new Set(warnings)].slice(0, 8);
  return { ...event, payload: next };
}
