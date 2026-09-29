import { dialog, BrowserWindow } from 'electron';
import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import { basename, extname } from 'node:path';
import { IpcInvoke } from '@shared/ipc-channels';
import type { SaveImageResult } from '@shared/event-images';
import { decodeEventImage } from '@main/store/event-image-files';
import { on } from './_helpers';

export function registerSaveImageIpc(): void {
  on(IpcInvoke.ImageSave, async (event, dataUrl, suggestedName): Promise<SaveImageResult> => {
    let image: ReturnType<typeof decodeEventImage>;
    try {
      if (typeof dataUrl !== 'string' || !dataUrl.startsWith('data:image/')) throw new Error('invalid');
      image = decodeEventImage(dataUrl);
    } catch { return { ok: false, reason: 'invalid_image' }; }
    const extension = image.mime === 'image/jpeg' ? 'jpg' : image.mime.slice('image/'.length);
    const candidate = typeof suggestedName === 'string'
      ? basename(suggestedName.replaceAll('\\', '/')).replace(/[\u0000-\u001f]/g, '').slice(0, 160)
      : 'image';
    const name = candidate.slice(0, candidate.length - extname(candidate).length) || 'image';
    try {
      const options = { title: '保存图片', defaultPath: `${name}.${extension}`,
        filters: [{ name: '图片', extensions: [extension] }] };
      const parent = BrowserWindow.fromWebContents(event.sender);
      const selected = parent ? await dialog.showSaveDialog(parent, options) : await dialog.showSaveDialog(options);
      if (selected.canceled || !selected.filePath) return { ok: false, reason: 'cancelled' };
      const handle = await open(selected.filePath,
        constants.O_WRONLY | constants.O_CREAT | constants.O_TRUNC | constants.O_NOFOLLOW, 0o600);
      try { await handle.writeFile(image.buffer); } finally { await handle.close(); }
      return { ok: true };
    } catch { return { ok: false, reason: 'io_error' }; }
  });
}
