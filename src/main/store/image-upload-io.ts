import { promises as fs } from 'node:fs';
import type { FileHandle } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { dirname } from 'node:path';
import { performance } from 'node:perf_hooks';
import {
  imageUploadErrorCode,
  probeImageUploadFilesystem,
  recordImageUploadDiagnostic,
  type ImageUploadDiagnostic,
} from './image-upload-diagnostics';

export const IMAGE_UPLOAD_TIMEOUT_MS = 10_000;
export const IMAGE_UPLOAD_CLEANUP_TIMEOUT_MS = 1_000;
const WRITE_CHUNK_BYTES = 256 * 1024;

export interface ImageUploadWriteOptions {
  /** A batch shares one monotonic deadline instead of paying the timeout for each image. */
  deadlineAt?: number;
  operationId?: string;
}

export class ImageUploadTimeoutError extends Error {
  readonly code = 'ETIMEDOUT';
  constructor() {
    super('图片保存超时，请重试。消息尚未发送，文字和图片已保留。');
    this.name = 'ImageUploadTimeoutError';
  }
}

/**
 * Own the native operation until it settles even if the caller's deadline expires first.
 * Each later write is fenced; an exclusive file belongs only to this attempt. Cleanup runs
 * after the last native write/close, so it cannot race a delayed open that recreates the file.
 */
export async function writeImageUploadFile(
  path: string,
  buffer: Buffer,
  options: ImageUploadWriteOptions = {},
): Promise<void> {
  const startedAt = performance.now();
  const deadlineAt = options.deadlineAt ?? startedAt + IMAGE_UPLOAD_TIMEOUT_MS;
  const operationId = options.operationId ?? randomUUID();
  const timeoutError = new ImageUploadTimeoutError();
  let expired = false;
  let phase: ImageUploadDiagnostic['phase'] = 'mkdir';
  let phaseStartedAt = startedAt;
  let writtenBytes = 0;
  const diagnostic = (outcome: ImageUploadDiagnostic['outcome'], error?: unknown): void => {
    const now = performance.now();
    recordImageUploadDiagnostic({
      operationId, phase, outcome, bytes: buffer.length, writtenBytes,
      durationMs: Math.round(now - startedAt), phaseDurationMs: Math.round(now - phaseStartedAt),
      ...(outcome === 'timeout' ? { timerLagMs: Math.max(0, Math.round(now - deadlineAt)) } : {}),
      ...(error ? { errorCode: imageUploadErrorCode(error) } : {}),
    });
  };
  const checkDeadline = (): void => {
    if (expired || performance.now() >= deadlineAt) {
      expire();
      throw timeoutError;
    }
  };
  const stage = (next: ImageUploadDiagnostic['phase']): void => {
    phase = next;
    phaseStartedAt = performance.now();
  };
  const expire = (): void => {
    if (expired) return;
    expired = true;
    diagnostic('timeout', timeoutError);
    probeImageUploadFilesystem(dirname(path), operationId);
  };
  if (startedAt >= deadlineAt) {
    expire();
    throw timeoutError;
  }
  let timer: ReturnType<typeof setTimeout>;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => { expire(); reject(timeoutError); }, deadlineAt - startedAt);
    timer.unref();
  });
  const work = (async () => {
    let handle: FileHandle | undefined;
    let ownsFile = false;
    let failure: unknown;
    try {
      await fs.mkdir(dirname(path), { recursive: true });
      checkDeadline();
      diagnostic('success');
      stage('open');
      handle = await fs.open(path, 'wx', 0o600);
      ownsFile = true;
      checkDeadline();
      diagnostic('success');
      stage('write');
      while (writtenBytes < buffer.length) {
        checkDeadline();
        const { bytesWritten } = await handle.write(
          buffer, writtenBytes, Math.min(WRITE_CHUNK_BYTES, buffer.length - writtenBytes), writtenBytes,
        );
        if (bytesWritten === 0) throw new Error('图片保存失败，请重试。');
        writtenBytes += bytesWritten;
      }
      checkDeadline();
      diagnostic('success');
    } catch (error) {
      failure = error;
      if (error !== timeoutError) diagnostic('error', error);
    } finally {
      if (handle) {
        stage('close');
        try { await handle.close(); } catch (error) {
          failure ??= error;
          diagnostic('error', error);
        }
      }
    }
    if (expired || performance.now() >= deadlineAt || failure === timeoutError) {
      expire();
      failure = timeoutError;
    }
    if (failure !== undefined) {
      // Do not wait for rollback to report an I/O error. Cleanup has its own bounded lifetime.
      if (ownsFile) void removeImageUploadFile(path, operationId);
      if (expired) diagnostic('late-error', failure);
      throw failure;
    }
    diagnostic('success');
  })();
  try {
    await Promise.race([work, timeout]);
  } finally {
    clearTimeout(timer!);
  }
}

/** A stalled rollback must not hold the IPC rejection or a retry hostage. */
export async function removeImageUploadFile(path: string, operationId: string = randomUUID()): Promise<void> {
  const startedAt = performance.now();
  let expired = false;
  const diagnostic = (outcome: ImageUploadDiagnostic['outcome'], error?: unknown): void => {
    const durationMs = Math.round(performance.now() - startedAt);
    recordImageUploadDiagnostic({
      operationId, phase: 'unlink', outcome, durationMs, phaseDurationMs: durationMs,
      ...(error ? { errorCode: imageUploadErrorCode(error) } : {}),
    });
  };
  let timer: ReturnType<typeof setTimeout>;
  const timeout = new Promise<void>((resolve) => {
    timer = setTimeout(() => { expired = true; diagnostic('timeout'); resolve(); }, IMAGE_UPLOAD_CLEANUP_TIMEOUT_MS);
    timer.unref();
  });
  const work = fs.unlink(path).then(
    () => { diagnostic(expired ? 'late-success' : 'success'); },
    (error: unknown) => {
      if (imageUploadErrorCode(error) === 'ENOENT') return;
      diagnostic(expired ? 'late-error' : 'error', error);
    },
  );
  try { await Promise.race([work, timeout]); } finally { clearTimeout(timer!); }
}
