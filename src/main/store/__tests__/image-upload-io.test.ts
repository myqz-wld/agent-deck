import { promises as fs } from 'node:fs';
import type { FileHandle } from 'node:fs/promises';
import { performance } from 'node:perf_hooks';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

const diagnostics = vi.hoisted(() => ({ record: vi.fn(), probe: vi.fn() }));
vi.mock('../image-upload-diagnostics', () => ({
  recordImageUploadDiagnostic: diagnostics.record,
  probeImageUploadFilesystem: diagnostics.probe,
  imageUploadErrorCode: (error: { code?: string }) => error?.code ?? 'unknown',
}));
import {
  IMAGE_UPLOAD_CLEANUP_TIMEOUT_MS,
  IMAGE_UPLOAD_TIMEOUT_MS,
  removeImageUploadFile,
  writeImageUploadFile,
} from '../image-upload-io';

const path = '/synthetic/uploads/owned.png';
const bytes = Buffer.from('synthetic image');
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}
function fileHandle() {
  return {
    write: vi.fn(async (_buffer, _offset, length) => ({ bytesWritten: length })),
    close: vi.fn(async (): Promise<void> => undefined),
  };
}
let handle: ReturnType<typeof fileHandle>;

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
  vi.spyOn(performance, 'now').mockImplementation(Date.now);
  handle = fileHandle();
  vi.spyOn(fs, 'mkdir').mockResolvedValue(undefined);
  vi.spyOn(fs, 'open').mockResolvedValue(handle as unknown as FileHandle);
  vi.spyOn(fs, 'unlink').mockResolvedValue(undefined);
});
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); vi.clearAllMocks(); });

it('bounds a stalled mkdir and fences its late completion before open', async () => {
  const pending = deferred<undefined>();
  vi.mocked(fs.mkdir).mockReturnValueOnce(pending.promise);
  const result = writeImageUploadFile(path, bytes).catch((error) => error);
  await vi.advanceTimersByTimeAsync(IMAGE_UPLOAD_TIMEOUT_MS);
  expect(await result).toMatchObject({ code: 'ETIMEDOUT' });
  expect(diagnostics.record).toHaveBeenCalledWith(expect.objectContaining({
    phase: 'mkdir', outcome: 'timeout', bytes: bytes.length,
  }));
  pending.resolve(undefined);
  await vi.advanceTimersByTimeAsync(0);
  expect(fs.open).not.toHaveBeenCalled();
  expect(fs.unlink).not.toHaveBeenCalled();
});

it('closes and deletes an exclusively created file when open completes after timeout', async () => {
  const pending = deferred<FileHandle>();
  vi.mocked(fs.open).mockReturnValueOnce(pending.promise);
  const result = writeImageUploadFile(path, bytes).catch((error) => error);
  await vi.advanceTimersByTimeAsync(IMAGE_UPLOAD_TIMEOUT_MS);
  expect(await result).toMatchObject({ code: 'ETIMEDOUT' });
  pending.resolve(handle as unknown as FileHandle);
  await vi.advanceTimersByTimeAsync(0);
  expect(handle.write).not.toHaveBeenCalled();
  expect(handle.close).toHaveBeenCalledOnce();
  expect(fs.unlink).toHaveBeenCalledWith(path);
});

it('lets retry succeed while the first write is pending, then cleans only the failed attempt', async () => {
  const pending = deferred<{ bytesWritten: number }>();
  handle.write.mockReturnValueOnce(pending.promise);
  const result = writeImageUploadFile(path, bytes).catch((error) => error);
  await vi.advanceTimersByTimeAsync(IMAGE_UPLOAD_TIMEOUT_MS);
  expect(await result).toMatchObject({ code: 'ETIMEDOUT' });
  expect(fs.unlink).not.toHaveBeenCalled();
  expect(handle.close).not.toHaveBeenCalled();
  const retryHandle = fileHandle();
  vi.mocked(fs.open).mockResolvedValueOnce(retryHandle as unknown as FileHandle);
  await writeImageUploadFile('/synthetic/uploads/retry.png', bytes);
  pending.resolve({ bytesWritten: bytes.length });
  await vi.advanceTimersByTimeAsync(0);
  expect(handle.close).toHaveBeenCalledOnce();
  expect(fs.unlink).toHaveBeenCalledOnce();
  expect(fs.unlink).toHaveBeenCalledWith(path);
});

it('waits for a late close before deleting, without delaying the timeout response', async () => {
  const pending = deferred<void>();
  handle.close.mockReturnValueOnce(pending.promise);
  const result = writeImageUploadFile(path, bytes).catch((error) => error);
  await vi.advanceTimersByTimeAsync(IMAGE_UPLOAD_TIMEOUT_MS);
  expect(await result).toMatchObject({ code: 'ETIMEDOUT' });
  expect(diagnostics.record).toHaveBeenCalledWith(expect.objectContaining({ phase: 'close', outcome: 'timeout' }));
  expect(fs.unlink).not.toHaveBeenCalled();
  pending.resolve();
  await vi.advanceTimersByTimeAsync(0);
  expect(fs.unlink).toHaveBeenCalledWith(path);
});

it('stops further chunks after the active write completes past its deadline', async () => {
  const pending = deferred<{ bytesWritten: number }>();
  handle.write.mockReturnValueOnce(pending.promise);
  const result = writeImageUploadFile(path, Buffer.alloc(300_000)).catch((error) => error);
  await vi.advanceTimersByTimeAsync(IMAGE_UPLOAD_TIMEOUT_MS);
  expect(await result).toMatchObject({ code: 'ETIMEDOUT' });
  pending.resolve({ bytesWritten: 17 });
  await vi.advanceTimersByTimeAsync(0);
  expect(handle.write).toHaveBeenCalledOnce();
  expect(handle.close).toHaveBeenCalledOnce();
  expect(fs.unlink).toHaveBeenCalledWith(path);
});

it('observes a late native rejection and cleans the partial file without another outward rejection', async () => {
  const pending = deferred<{ bytesWritten: number }>();
  handle.write.mockReturnValueOnce(pending.promise);
  const result = writeImageUploadFile(path, bytes).catch((error) => error);
  await vi.advanceTimersByTimeAsync(IMAGE_UPLOAD_TIMEOUT_MS);
  expect(await result).toMatchObject({ code: 'ETIMEDOUT' });
  pending.reject(Object.assign(new Error('late failure'), { code: 'EIO' }));
  await vi.advanceTimersByTimeAsync(0);
  expect(fs.unlink).toHaveBeenCalledWith(path);
  expect(diagnostics.record).toHaveBeenCalledWith(expect.objectContaining({ phase: 'write', errorCode: 'EIO' }));
});

it('preserves an existing file when exclusive open fails', async () => {
  const error = Object.assign(new Error('existing'), { code: 'EEXIST' });
  vi.mocked(fs.open).mockRejectedValueOnce(error);
  await expect(writeImageUploadFile(path, bytes)).rejects.toBe(error);
  expect(fs.unlink).not.toHaveBeenCalled();
  expect(diagnostics.record).toHaveBeenCalledWith(expect.objectContaining({ phase: 'open', outcome: 'error' }));
});

it('reports the original write error even when rollback never settles', async () => {
  const error = Object.assign(new Error('disk full'), { code: 'ENOSPC' });
  handle.write.mockRejectedValueOnce(error);
  const pending = deferred<void>();
  vi.mocked(fs.unlink).mockReturnValueOnce(pending.promise);
  await expect(writeImageUploadFile(path, bytes)).rejects.toBe(error);
  expect(handle.close).toHaveBeenCalledOnce();
  await vi.advanceTimersByTimeAsync(IMAGE_UPLOAD_CLEANUP_TIMEOUT_MS);
  expect(diagnostics.record).toHaveBeenCalledWith(expect.objectContaining({ phase: 'write', errorCode: 'ENOSPC' }));
  expect(diagnostics.record).toHaveBeenCalledWith(expect.objectContaining({ phase: 'unlink', outcome: 'timeout' }));
  pending.resolve();
  await vi.advanceTimersByTimeAsync(0);
});

it('completes short writes and never resolves before closing the descriptor', async () => {
  handle.write.mockResolvedValueOnce({ bytesWritten: 2 });
  await writeImageUploadFile(path, bytes);
  expect(handle.write.mock.calls[1]).toEqual([bytes, 2, bytes.length - 2, 2]);
  expect(handle.close).toHaveBeenCalledOnce();
  expect(fs.open).toHaveBeenCalledWith(path, 'wx', 0o600);
  expect(fs.unlink).not.toHaveBeenCalled();
  expect(vi.getTimerCount()).toBe(0);
});

it('uses the caller deadline and skips all writes if it already elapsed', async () => {
  await expect(writeImageUploadFile(path, bytes, { deadlineAt: performance.now() - 1 }))
    .rejects.toMatchObject({ code: 'ETIMEDOUT' });
  expect(fs.mkdir).not.toHaveBeenCalled();
});

it('records the expired write phase even if its completion precedes the overdue timer callback', async () => {
  handle.write.mockImplementationOnce(async () => {
    vi.setSystemTime(Date.now() + IMAGE_UPLOAD_TIMEOUT_MS + 1);
    return { bytesWritten: bytes.length };
  });
  await expect(writeImageUploadFile(path, bytes)).rejects.toMatchObject({ code: 'ETIMEDOUT' });
  expect(diagnostics.record).toHaveBeenCalledWith(expect.objectContaining({ phase: 'write', outcome: 'timeout' }));
  expect(handle.close).toHaveBeenCalledOnce();
  expect(fs.unlink).toHaveBeenCalledWith(path);
});

it('bounds explicit cleanup and observes its late rejection', async () => {
  const pending = deferred<void>();
  vi.mocked(fs.unlink).mockReturnValueOnce(pending.promise);
  const removed = removeImageUploadFile(path);
  await vi.advanceTimersByTimeAsync(IMAGE_UPLOAD_CLEANUP_TIMEOUT_MS);
  await removed;
  pending.reject(Object.assign(new Error('synthetic'), { code: 'EIO' }));
  await vi.advanceTimersByTimeAsync(0);
  expect(diagnostics.record).toHaveBeenCalledWith(expect.objectContaining({ phase: 'unlink', outcome: 'late-error' }));
});
