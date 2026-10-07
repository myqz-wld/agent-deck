import { stat } from 'node:fs';
import { performance } from 'node:perf_hooks';
import log from '@main/utils/logger';

const logger = log.scope('store-image-uploads');
const PROBE_TIMEOUT_MS = 250;
let probePending = false;

export interface ImageUploadDiagnostic {
  operationId: string;
  phase: 'mkdir' | 'open' | 'write' | 'close' | 'unlink' | 'probe';
  outcome: 'success' | 'error' | 'timeout' | 'late-success' | 'late-error' | 'probe-pending';
  durationMs: number;
  phaseDurationMs: number;
  bytes?: number;
  writtenBytes?: number;
  timerLagMs?: number;
  errorCode?: string;
}

/** Counts only: never log request objects, filenames, buffers, or provider configuration. */
export function imageUploadResourceCounts(): Record<string, number> {
  const counts = { fsPromises: 0, fsCallbacks: 0, fsCloses: 0 };
  for (const type of process.getActiveResourcesInfo()) {
    if (type === 'FSReqPromise') counts.fsPromises += 1;
    else if (type === 'FSReqCallback') counts.fsCallbacks += 1;
    else if (type === 'FileHandleCloseReq') counts.fsCloses += 1;
  }
  return counts;
}

export function imageUploadErrorCode(error: unknown): string {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === 'string' && /^E[A-Z0-9]{1,24}$/.test(code) ? code : 'unknown';
}

export function recordImageUploadDiagnostic(diagnostic: ImageUploadDiagnostic): void {
  try {
    const level = diagnostic.outcome === 'success' && diagnostic.durationMs < 2_000
      ? diagnostic.phase === 'probe' ? 'info' : 'debug'
      : 'warn';
    logger[level]('[image-uploads] filesystem operation', {
      event: 'image_upload_io',
      ...diagnostic,
      ...imageUploadResourceCounts(),
    });
  } catch {
    // Diagnostics cannot affect upload settlement or late cleanup.
  }
}

/**
 * A callback-based request on the same directory distinguishes a stuck upload from broader
 * filesystem scheduling trouble. At most one native probe may remain pending in this process.
 * A successful probe does not by itself identify why the original operation was delayed.
 */
export function probeImageUploadFilesystem(directory: string, operationId: string): void {
  if (probePending) {
    recordImageUploadDiagnostic({
      operationId, phase: 'probe', outcome: 'probe-pending', durationMs: 0, phaseDurationMs: 0,
    });
    return;
  }
  probePending = true;
  const startedAt = performance.now();
  let expired = false;
  const timer = setTimeout(() => {
    expired = true;
    const durationMs = Math.round(performance.now() - startedAt);
    recordImageUploadDiagnostic({
      operationId, phase: 'probe', outcome: 'timeout', durationMs, phaseDurationMs: durationMs,
      timerLagMs: Math.max(0, durationMs - PROBE_TIMEOUT_MS),
    });
  }, PROBE_TIMEOUT_MS);
  timer.unref();
  const complete = (error: unknown): void => {
    probePending = false;
    clearTimeout(timer);
    const durationMs = Math.round(performance.now() - startedAt);
    recordImageUploadDiagnostic({
      operationId, phase: 'probe',
      outcome: expired ? (error ? 'late-error' : 'late-success') : (error ? 'error' : 'success'),
      durationMs, phaseDurationMs: durationMs,
      ...(error ? { errorCode: imageUploadErrorCode(error) } : {}),
    });
  };
  try { stat(directory, complete); } catch (error) { complete(error); }
}
