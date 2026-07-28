import { createReadStream } from 'node:fs';

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
}

/**
 * Read one optional provider config without letting filesystem latency hold the main process.
 *
 * Node's default reader receives the deadline signal, while the enclosing settlement fence also
 * bounds injected or platform readers that fail to observe abort. Accepted content is capped by
 * encoded bytes before it can enter a parser.
 */
export async function readBoundedConfigText(
  path: string,
  options: BoundedConfigReadOptions,
): Promise<BoundedConfigReadResult> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_SESSION_CONFIG_READ_TIMEOUT_MS;
  const maxBytes = options.maxBytes ?? DEFAULT_SESSION_CONFIG_MAX_BYTES;
  const controller = new AbortController();
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
      readFileWithByteCap(targetPath, signal, maxBytes));

  try {
    const raw = await Promise.race([
      configuredReader(path, controller.signal),
      timeout,
    ]);
    const bytes =
      typeof raw === 'string' ? Buffer.byteLength(raw, 'utf8') : raw.byteLength;
    if (bytes > maxBytes) {
      return failure(options, 'oversize');
    }
    return {
      ok: true,
      text: typeof raw === 'string' ? raw : Buffer.from(raw).toString('utf8'),
    };
  } catch (error) {
    if (timedOut || controller.signal.aborted) {
      return failure(options, 'timeout');
    }
    const code = readErrorCode(error);
    return failure(options, code === 'ENOENT' ? 'not-found' : 'unreadable');
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

function readFileWithByteCap(
  path: string,
  signal: AbortSignal,
  maxBytes: number,
): Promise<Uint8Array> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    const stream = createReadStream(path, {
      // `end` is inclusive, so this reads at most maxBytes + 1 for oversize detection.
      end: maxBytes,
      signal,
    });
    stream.on('data', (chunk: Buffer | string) => {
      chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk);
    });
    stream.once('end', () => resolve(Buffer.concat(chunks)));
    stream.once('error', reject);
  });
}

function failure(
  options: BoundedConfigReadOptions,
  failureCategory: SessionConfigFailureCategory,
): BoundedConfigReadResult {
  try {
    options.onDiagnostic?.({
      resolutionSource: options.resolutionSource,
      failureCategory,
    });
  } catch {
    // Diagnostics must never change the resolver's terminal fallback.
  }
  return { ok: false, failureCategory };
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
