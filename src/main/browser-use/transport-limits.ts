export interface BrowserUseTransportLimits {
  maxFrameBytes: number;
  maxInputChunkBytes: number;
  maxMessagesPerInputChunk: number;
  maxRetainedInputBytes: number;
  maxRetainedInputChunks: number;
  maxInflightRequests: number;
  maxOutputFrameBytes: number;
  maxQueuedOutputBytes: number;
  drainTimeoutMs: number;
}

export const DEFAULT_BROWSER_USE_TRANSPORT_LIMITS: Readonly<BrowserUseTransportLimits> =
  Object.freeze({
    maxFrameBytes: 8 * 1024 * 1024,
    maxInputChunkBytes: 8 * 1024 * 1024 + 4,
    maxMessagesPerInputChunk: 1024,
    maxRetainedInputBytes: 8 * 1024 * 1024 + 4,
    maxRetainedInputChunks: 4096,
    maxInflightRequests: 32,
    maxOutputFrameBytes: 8 * 1024 * 1024,
    maxQueuedOutputBytes: 16 * 1024 * 1024,
    drainTimeoutMs: 10_000,
  });

export function resolveBrowserUseTransportLimits(
  overrides: Partial<BrowserUseTransportLimits> = {},
): BrowserUseTransportLimits {
  const resolved = {
    ...DEFAULT_BROWSER_USE_TRANSPORT_LIMITS,
    ...overrides,
  };
  for (const value of Object.values(resolved)) {
    if (!Number.isSafeInteger(value) || value <= 0) {
      throw new Error('Browser transport configuration is invalid.');
    }
  }
  return resolved;
}
