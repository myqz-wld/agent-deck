import { useContext, useState, type JSX } from 'react';
import { eventImages, type EventImageRef } from '@shared/event-images';
import { useImageBlob } from '@renderer/hooks/useImageBlob';
import { DataUrlImageLightbox } from '../../ImageLightbox';
import { ActivityImageContext, eventImageBlobCache, type ActivityImageReader } from '../image-context';
import { SaveIcon } from '../../icons';

export function EventImages({ payload, sessionId }: { payload: unknown; sessionId: string }): JSX.Element | null {
  const images = eventImages(payload);
  const reader = useContext(ActivityImageContext);
  const warnings = (payload as { imageWarnings?: unknown } | null)?.imageWarnings;
  if (!images.length && !Array.isArray(warnings)) return null;
  return <div className="mt-2 min-w-0">
    <div className="flex flex-wrap gap-2">
      {images.map((image) => reader
        ? <EventImage key={`${reader.identity}:${sessionId}:${image.id}`} image={image} sessionId={sessionId} reader={reader} />
        : <span key={image.id} className="text-[10px] text-deck-muted">当前来源暂不支持读取图片：{image.name}</span>)}
    </div>
    {Array.isArray(warnings) && warnings.filter((value): value is string => typeof value === 'string')
      .map((warning, index) => <div key={index} className="mt-1 text-[10px] text-status-waiting">{warning}</div>)}
  </div>;
}

function EventImage({ image, sessionId, reader }: { image: EventImageRef; sessionId: string; reader: ActivityImageReader }): JSX.Element {
  const [open, setOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [notice, setNotice] = useState('');
  const [invalid, setInvalid] = useState(false);
  const state = useImageBlob(() => reader.load(sessionId, { kind: 'event-image', imageId: image.id }),
    `event-image:${reader.identity}:${sessionId}:${image.id}`, eventImageBlobCache);
  const result = state.result;
  const save = async (): Promise<void> => {
    if (!result?.ok || saving) return;
    setSaving(true);
    setNotice('');
    try {
      const saved = await window.api.saveImage(result.dataUrl, image.name);
      setNotice(saved.ok ? '图片已保存' : saved.reason === 'cancelled' ? '' : '保存失败，请重试');
    } catch { setNotice('保存失败，请重试'); }
    finally { setSaving(false); }
  };
  if (state.loading) return <div className="flex h-24 w-36 items-center justify-center rounded border border-deck-border text-[10px] text-deck-muted">加载图片中…</div>;
  if (!result?.ok || invalid) return <div className="rounded border border-deck-border px-3 py-4 text-[10px] text-deck-muted">
    {result && !result.ok && result.reason === 'enoent' ? '图片文件不存在'
      : result && !result.ok && result.reason === 'denied' ? '图片不可访问' : '图片加载失败'}
    <div className="mt-1 max-w-48 truncate" title={image.name}>{image.name}</div>
  </div>;
  return <figure className="m-0 max-w-full">
    <button type="button" onClick={() => setOpen(true)} aria-label={`放大图片：${image.name}`}
      className="block max-w-full overflow-hidden rounded-md border border-deck-border bg-black/15 outline-none focus-visible:ring-1 focus-visible:ring-deck-accent">
      <img src={result.dataUrl} alt={image.name} onError={() => setInvalid(true)} className="max-h-48 max-w-full object-contain" />
    </button>
    <figcaption className="mt-1 flex items-center gap-2 text-[10px] text-deck-muted">
      <span className="min-w-0 max-w-48 truncate" title={image.name}>{image.name}</span>
      <button type="button" onClick={() => void save()} disabled={saving} aria-busy={saving}
        className="inline-flex shrink-0 items-center gap-1 rounded px-1.5 py-0.5 hover:bg-white/10 hover:text-deck-text active:bg-white/20 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-deck-accent disabled:cursor-wait disabled:opacity-60">
        <SaveIcon className="h-3 w-3" />{saving ? '保存中…' : '保存图片'}
      </button>
    </figcaption>
    {notice && <div role="status" className="mt-1 text-[10px] text-deck-muted">{notice}</div>}
    {open && <DataUrlImageLightbox dataUrl={result.dataUrl} alt={image.name} onClose={() => setOpen(false)}
      onSave={() => void save()} saving={saving} notice={notice} />}
  </figure>;
}
