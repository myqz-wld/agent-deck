import { open as nodeOpen, type FileHandle } from 'node:fs/promises';
import { performance } from 'node:perf_hooks';

export const DEFAULT_SESSION_CONFIG_READ_TIMEOUT_MS = 250;
export const DEFAULT_SESSION_CONFIG_MAX_BYTES = 256 * 1024;

export type SessionConfigResolutionSource =
  | 'claude-gateway'
  | 'claude-settings'
  | 'codex-app-server'
  | 'codex-config'
  | 'grok-config';

export type SessionConfigFailureCategory =
  | 'invalid'
  | 'not-found'
  | 'oversize'
  | 'timeout'
  | 'unreadable';

export interface SessionConfigDiagnostic {
  resolutionSource: SessionConfigResolutionSource;
  failureCategory: SessionConfigFailureCategory;
  backend?: SessionConfigReadBackend;
  stage?: SessionConfigReadStage;
  durationMs?: number;
  bytes?: number | null;
}

export type SessionConfigReadStage =
  | 'opening'
  | 'reading'
  | 'closing'
  | 'custom-reader'
  | 'validating';

export type SessionConfigReadBackend =
  | 'electron-original-fs'
  | 'node-fs'
  | 'custom-reader';

export interface SessionConfigReadObservation {
  resolutionSource: SessionConfigResolutionSource;
  outcome: 'success' | SessionConfigFailureCategory;
  backend: SessionConfigReadBackend;
  stage: SessionConfigReadStage;
  durationMs: number;
  bytes: number | null;
}

export type BoundedConfigReadResult =
  | { ok: true; text: string }
  | { ok: false; failureCategory: SessionConfigFailureCategory };

interface BoundedConfigReadOptions {
  resolutionSource: SessionConfigResolutionSource;
  timeoutMs?: number;
  maxBytes?: number;
  readFile?: (
    path: string,
    signal: AbortSignal,
  ) => Promise<string | Uint8Array>;
  onDiagnostic?: (diagnostic: SessionConfigDiagnostic) => void;
  onObservation?: (observation: SessionConfigReadObservation) => void;
}

interface ReadState {
  backend: SessionConfigReadBackend;
  stage: SessionConfigReadStage;
}

type OpenFile = typeof nodeOpen;

const hostFileOpen = resolveHostFileOpen();

/**
 * Read one optional provider config without letting filesystem latency hold the main process.
 *
 * The default descriptor reader observes the deadline between bounded operations, while the
 * enclosing settlement fence also bounds injected or platform readers that fail to observe
 * abort. Accepted content is capped by encoded bytes before it can enter a parser.
 */
export async function readBoundedConfigText(
  path: string,
  options: BoundedConfigReadOptions,
): Promise<BoundedConfigReadResult> {
  const startedAt = performance.now();
  const timeoutMs = options.timeoutMs ?? DEFAULT_SESSION_CONFIG_READ_TIMEOUT_MS;
  const maxBytes = options.maxBytes ?? DEFAULT_SESSION_CONFIG_MAX_BYTES;
  const controller = new AbortController();
  const state: ReadState = {
    backend: options.readFile ? 'custom-reader' : hostFileOpen.backend,
    stage: options.readFile ? 'custom-reader' : 'opening',
  };
  let timedOut = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
      reject(new Error('session config read deadline exceeded'));
    }, timeoutMs);
    timer.unref?.();
  });
  const configuredReader =
    options.readFile ??
    ((targetPath: string, signal: AbortSignal) =>
      readFileWithByteCap(targetPath, signal, maxBytes, state));

  try {
    const raw = await Promise.race([
      configuredReader(path, controller.signal),
      timeout,
    ]);
    state.stage = 'validating';
    const bytes =
      typeof raw === 'string' ? Buffer.byteLength(raw, 'utf8') : raw.byteLength;
    if (bytes > maxBytes) {
      return failure(options, 'oversize', state, startedAt, bytes);
    }
    observe(options, 'success', state, startedAt, bytes);
    return {
      ok: true,
      text: typeof raw === 'string' ? raw : Buffer.from(raw).toString('utf8'),
    };
  } catch (error) {
    if (timedOut || controller.signal.aborted) {
      return failure(options, 'timeout', state, startedAt, null);
    }
    const code = readErrorCode(error);
    return failure(
      options,
      code === 'ENOENT' ? 'not-found' : 'unreadable',
      state,
      startedAt,
      null,
    );
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

async function readFileWithByteCap(
  path: string,
  signal: AbortSignal,
  maxBytes: number,
  state: ReadState,
): Promise<Uint8Array> {
  state.stage = 'opening';
  const handle = await hostFileOpen.open(path, 'r');
  try {
    throwIfAborted(signal);
    state.stage = 'reading';
    // One extra byte distinguishes an exact-boundary file from an oversized file without ever
    // allocating or reading the full contents of an untrusted or unexpectedly large config.
    const buffer = Buffer.allocUnsafe(maxBytes + 1);
    let offset = 0;
    while (offset < buffer.byteLength) {
      const { bytesRead } = await handle.read(
        buffer,
        offset,
        buffer.byteLength - offset,
        offset,
      );
      if (bytesRead === 0) break;
      offset += bytesRead;
      throwIfAborted(signal);
    }
    return buffer.subarray(0, offset);
  } finally {
    state.stage = 'closing';
    await closeFile(handle);
  }
}

function failure(
  options: BoundedConfigReadOptions,
  failureCategory: SessionConfigFailureCategory,
  state: ReadState,
  startedAt: number,
  bytes: number | null,
): BoundedConfigReadResult {
  const observation = observe(options, failureCategory, state, startedAt, bytes);
  try {
    options.onDiagnostic?.({
      resolutionSource: options.resolutionSource,
      failureCategory,
      backend: observation.backend,
      stage: observation.stage,
      durationMs: observation.durationMs,
      bytes: observation.bytes,
    });
  } catch {
    // Diagnostics must never change the resolver's terminal fallback.
  }
  return { ok: false, failureCategory };
}

function observe(
  options: BoundedConfigReadOptions,
  outcome: SessionConfigReadObservation['outcome'],
  state: ReadState,
  startedAt: number,
  bytes: number | null,
): SessionConfigReadObservation {
  const observation: SessionConfigReadObservation = {
    resolutionSource: options.resolutionSource,
    outcome,
    backend: state.backend,
    stage: state.stage,
    durationMs: elapsedMs(startedAt),
    bytes,
  };
  try {
    options.onObservation?.(observation);
  } catch {
    // Observability cannot change read results or fallback behavior.
  }
  return observation;
}

function resolveHostFileOpen(): {
  backend: Exclude<SessionConfigReadBackend, 'custom-reader'>;
  open: OpenFile;
} {
  try {
    const getBuiltinModule = (
      process as NodeJS.Process & { getBuiltinModule?: (specifier: string) => unknown }
    ).getBuiltinModule;
    const originalFs = getBuiltinModule?.('original-fs');
    if (isOriginalFs(originalFs)) {
      return {
        backend: 'electron-original-fs',
        open: originalFs.promises.open.bind(originalFs.promises) as OpenFile,
      };
    }
  } catch {
    // Plain Node and non-Electron hosts use the native node:fs/promises implementation.
  }
  return { backend: 'node-fs', open: nodeOpen };
}

function isOriginalFs(value: unknown): value is {
  promises: { open: OpenFile };
} {
  if (!value || typeof value !== 'object') return false;
  const promises = (value as { promises?: unknown }).promises;
  return Boolean(
    promises && typeof promises === 'object' &&
    typeof (promises as { open?: unknown }).open === 'function',
  );
}

function throwIfAborted(signal: AbortSignal): void {
  if (!signal.aborted) return;
  const error = new Error('session config read aborted');
  error.name = 'AbortError';
  throw error;
}

async function closeFile(handle: FileHandle): Promise<void> {
  await handle.close();
}

function elapsedMs(startedAt: number): number {
  const elapsed = performance.now() - startedAt;
  if (!Number.isFinite(elapsed)) return 0;
  return Math.max(0, Math.round(elapsed));
}

function readErrorCode(error: unknown): string | undefined {
  if (!error || typeof error !== 'object') return undefined;
  try {
    const code = (error as { code?: unknown }).code;
    return typeof code === 'string' ? code : undefined;
  } catch {
    return undefined;
  }
}
