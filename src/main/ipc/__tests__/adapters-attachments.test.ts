import { promises as fs } from 'node:fs';
import type { FileHandle } from 'node:fs/promises';
import { performance } from 'node:perf_hooks';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

vi.mock('@main/paths', () => ({ getImageUploadsDir: () => '/synthetic/uploads' }));
vi.mock('@main/store/image-upload-diagnostics', () => ({
  recordImageUploadDiagnostic: vi.fn(), probeImageUploadFilesystem: vi.fn(),
  imageUploadErrorCode: (error: { code?: string }) => error?.code ?? 'unknown',
}));
import { persistAdapterAttachments } from '../adapters-attachments';
import { IMAGE_UPLOAD_TIMEOUT_MS, IMAGE_UPLOAD_CLEANUP_TIMEOUT_MS } from '@main/store/image-upload-io';

const image = { kind: 'image', base64: 'YWJj', mime: 'image/png', bytes: 3 };
beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
  vi.spyOn(performance, 'now').mockImplementation(Date.now);
  vi.spyOn(fs, 'mkdir').mockResolvedValue(undefined);
  vi.spyOn(fs, 'open').mockImplementation(async () => ({
    write: async (_buffer: Buffer, _offset: number, length: number) => ({ bytesWritten: length }),
    close: async () => undefined,
  }) as FileHandle);
  vi.spyOn(fs, 'unlink').mockResolvedValue(undefined);
});
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

it('shares one deadline across images and bounds sibling rollback before rejecting', async () => {
  let finishSecond!: () => void;
  let finishCleanup!: () => void;
  vi.mocked(fs.mkdir)
    .mockImplementationOnce(() => new Promise((resolve) => setTimeout(() => resolve(undefined), 6_000)))
    .mockImplementationOnce(() => new Promise((resolve) => { finishSecond = () => resolve(undefined); }));
  vi.mocked(fs.unlink).mockImplementationOnce(() => new Promise((resolve) => { finishCleanup = resolve; }));
  const rejected = vi.fn();
  const provider = vi.fn();
  const result = persistAdapterAttachments([image, image, image], 'attachments').then(provider, rejected);
  await vi.advanceTimersByTimeAsync(IMAGE_UPLOAD_TIMEOUT_MS);
  expect(fs.open).toHaveBeenCalledTimes(1);
  expect(fs.unlink).toHaveBeenCalledOnce();
  await vi.advanceTimersByTimeAsync(IMAGE_UPLOAD_CLEANUP_TIMEOUT_MS);
  await result;
  expect(rejected).toHaveBeenCalledWith(expect.objectContaining({ code: 'ETIMEDOUT' }));
  expect(provider).not.toHaveBeenCalled();
  finishSecond();
  finishCleanup();
  await vi.advanceTimersByTimeAsync(0);
  expect(fs.open).toHaveBeenCalledTimes(1);
  expect(provider).not.toHaveBeenCalled();
});

it('keeps the text-only path independent of filesystem availability', async () => {
  vi.mocked(fs.mkdir).mockImplementation(() => new Promise(() => {}));
  await expect(persistAdapterAttachments(undefined, 'attachments')).resolves.toEqual([]);
  await expect(persistAdapterAttachments([], 'attachments')).resolves.toEqual([]);
  expect(fs.mkdir).not.toHaveBeenCalled();
});

it('rolls back the first image when the next image fails byte validation', async () => {
  await expect(persistAdapterAttachments([image, { ...image, bytes: 4 }], 'attachments'))
    .rejects.toThrow('bytes mismatch');
  expect(fs.open).toHaveBeenCalledTimes(1);
  expect(fs.unlink).toHaveBeenCalledWith(vi.mocked(fs.open).mock.calls[0][0]);
});
