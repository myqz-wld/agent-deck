import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ipcMain } from 'electron';
import { IpcInvoke } from '@shared/ipc-channels';

const fileChangeReadRepoMock = vi.hoisted(() => ({
  hasImagePathForSession: vi.fn(),
}));
const eventRepoMock = vi.hoisted(() => ({
  hasToolUseStartWithFilePath: vi.fn(),
}));
const fsMock = vi.hoisted(() => ({
  realpath: vi.fn(),
  open: vi.fn(),
}));
const fileHandle = vi.hoisted(() => ({
  stat: vi.fn(),
  readFile: vi.fn(),
  close: vi.fn(),
}));

vi.mock('@main/store/file-change-read-repo', () => ({
  fileChangeReadRepo: fileChangeReadRepoMock,
}));
vi.mock('@main/store/event-repo', () => ({ eventRepo: eventRepoMock }));
vi.mock('@main/store/image-uploads', () => ({ loadUploadedImage: vi.fn() }));
vi.mock('@main/utils/logger', () => ({
  default: { scope: () => ({ warn: vi.fn(), error: vi.fn(), info: vi.fn() }) },
}));
vi.mock('node:fs', () => ({ promises: fsMock }));

import { registerImagesIpc } from '../images';

function imageHandler() {
  return vi
    .mocked(ipcMain.handle)
    .mock.calls.find(([channel]) => channel === IpcInvoke.ImageLoadBlob)?.[1];
}

describe('ImageLoadBlob targeted authorization', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    fsMock.realpath.mockResolvedValue('/real/image.png');
    fsMock.open.mockResolvedValue(fileHandle);
    fileHandle.stat.mockResolvedValue({ size: 4 });
    fileHandle.readFile.mockResolvedValue(Buffer.from('safe'));
    fileHandle.close.mockResolvedValue(undefined);
    eventRepoMock.hasToolUseStartWithFilePath.mockReturnValue(false);
    registerImagesIpc();
  });

  it('accepts authorization recorded for the requested path without a full list read', async () => {
    fileChangeReadRepoMock.hasImagePathForSession.mockReturnValue(true);
    const invoke = imageHandler();

    const result = await invoke!({} as never, 's1', {
      kind: 'path',
      path: '/requested/image.png',
    });

    expect(result).toMatchObject({ ok: true, mime: 'image/png', bytes: 4 });
    expect(fileChangeReadRepoMock.hasImagePathForSession).toHaveBeenCalledWith(
      's1',
      '/requested/image.png',
    );
    expect(fileChangeReadRepoMock.hasImagePathForSession).toHaveBeenCalledTimes(1);
  });

  it('also accepts authorization recorded only for the canonical realpath', async () => {
    fileChangeReadRepoMock.hasImagePathForSession
      .mockReturnValueOnce(false)
      .mockReturnValueOnce(true);
    const invoke = imageHandler();

    const result = await invoke!({} as never, 's1', {
      kind: 'path',
      path: '/requested/image.png',
    });

    expect(result).toMatchObject({ ok: true });
    expect(fileChangeReadRepoMock.hasImagePathForSession.mock.calls).toEqual([
      ['s1', '/requested/image.png'],
      ['s1', '/real/image.png'],
    ]);
  });
});
