import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { dialog, ipcMain } from 'electron';
import { mkdtempSync, readFileSync, rmSync, writeFileSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { IpcInvoke } from '@shared/ipc-channels';
import { registerSaveImageIpc } from '../save-image';

const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jK1cAAAAASUVORK5CYII=';
let root: string;
beforeEach(() => { vi.clearAllMocks(); root = mkdtempSync(join(tmpdir(), 'image-save-test-')); registerSaveImageIpc(); });
afterEach(() => rmSync(root, { recursive: true, force: true }));
function invoke(dataUrl: string, name = 'generated.png') {
  const handler = vi.mocked(ipcMain.handle).mock.calls.find(([channel]) => channel === IpcInvoke.ImageSave)![1];
  return handler({ sender: {} } as never, dataUrl, name);
}
describe('save image IPC', () => {
  it('writes the original bytes to the user-selected file', async () => {
    const filePath = join(root, 'chosen.png');
    vi.mocked(dialog.showSaveDialog).mockResolvedValue({ canceled: false, filePath });
    expect(await invoke(`data:image/png;base64,${PNG}`, '../../generated.jpg')).toEqual({ ok: true });
    expect(readFileSync(filePath)).toEqual(Buffer.from(PNG, 'base64'));
    expect(dialog.showSaveDialog).toHaveBeenCalledWith(expect.objectContaining({ defaultPath: 'generated.png' }));
  });
  it('treats destination cancellation as a normal result', async () => {
    vi.mocked(dialog.showSaveDialog).mockResolvedValue({ canceled: true, filePath: '' });
    expect(await invoke(`data:image/png;base64,${PNG}`)).toEqual({ ok: false, reason: 'cancelled' });
  });
  it('rejects remote URLs before opening a destination picker', async () => {
    expect(await invoke('https://example.test/image.png')).toEqual({ ok: false, reason: 'invalid_image' });
    expect(dialog.showSaveDialog).not.toHaveBeenCalled();
  });
  it('does not follow a destination symlink', async () => {
    const target = join(root, 'original');
    const filePath = join(root, 'link.png');
    writeFileSync(target, 'keep');
    symlinkSync(target, filePath);
    vi.mocked(dialog.showSaveDialog).mockResolvedValue({ canceled: false, filePath });
    expect(await invoke(`data:image/png;base64,${PNG}`)).toEqual({ ok: false, reason: 'io_error' });
    expect(readFileSync(target, 'utf8')).toBe('keep');
  });
});
