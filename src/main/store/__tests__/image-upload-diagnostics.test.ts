import { afterEach, beforeEach, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ stat: vi.fn(), info: vi.fn(), debug: vi.fn(), warn: vi.fn() }));
vi.mock('node:fs', async (importOriginal) => ({
  ...(await importOriginal<typeof import('node:fs')>()), stat: mocks.stat,
}));
vi.mock('@main/utils/logger', () => ({ default: { scope: () => mocks } }));
import {
  imageUploadResourceCounts, probeImageUploadFilesystem, recordImageUploadDiagnostic,
} from '../image-upload-diagnostics';

beforeEach(() => { vi.useFakeTimers(); vi.clearAllMocks(); });
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

it('reports resource counts without request contents or paths', () => {
  vi.spyOn(process, 'getActiveResourcesInfo').mockReturnValue([
    'FSReqPromise', 'FSReqPromise', 'FSReqCallback', 'FileHandleCloseReq', 'Timeout',
  ]);
  expect(imageUploadResourceCounts()).toEqual({ fsPromises: 2, fsCallbacks: 1, fsCloses: 1 });
  recordImageUploadDiagnostic({
    operationId: 'synthetic', phase: 'open', outcome: 'timeout', durationMs: 10000, phaseDurationMs: 9999,
  });
  expect(mocks.warn).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({
    event: 'image_upload_io', fsPromises: 2, fsCallbacks: 1, phase: 'open',
  }));
});

it('coalesces a stuck probe and logs its eventual completion at visible level', async () => {
  probeImageUploadFilesystem('/private-synthetic/uploads', 'first');
  await vi.advanceTimersByTimeAsync(250);
  probeImageUploadFilesystem('/private-synthetic/uploads', 'second');
  expect(mocks.stat).toHaveBeenCalledOnce();
  expect(mocks.warn).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({
    operationId: 'first', phase: 'probe', outcome: 'timeout',
  }));
  expect(mocks.warn).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({ outcome: 'probe-pending' }));
  mocks.stat.mock.calls[0][1](null);
  expect(mocks.warn).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({ outcome: 'late-success' }));
  probeImageUploadFilesystem('/private-synthetic/uploads', 'third');
  mocks.stat.mock.calls[1][1](null);
  expect(mocks.info).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({ outcome: 'success' }));
  expect(JSON.stringify([...mocks.warn.mock.calls, ...mocks.info.mock.calls])).not.toContain('private-synthetic');
});

it('does not let a logging exception escape into upload settlement', () => {
  mocks.warn.mockImplementationOnce(() => { throw new Error('logger unavailable'); });
  expect(() => recordImageUploadDiagnostic({
    operationId: 'synthetic', phase: 'write', outcome: 'timeout', durationMs: 10000, phaseDurationMs: 10000,
  })).not.toThrow();
});
