import { createConnection } from 'node:net';

import { BrowserUseFrameDecoder } from './protocol';
import { BROWSER_CLI_MAX_RESPONSE_BYTES } from './browser-cli-broker-protocol';

const RELAY_TIMEOUT_MS = 40_000;

/** Relays one already-framed CLI request to the private broker and returns one framed response. */
export function relayBrowserCliFrame(
  endpoint: string,
  request: Buffer,
  signal?: AbortSignal,
): Promise<Buffer> {
  if (!Buffer.isBuffer(request) || request.byteLength < 5 || signal?.aborted) {
    return Promise.reject(new Error('Browser relay request was rejected'));
  }
  return new Promise((resolve, reject) => {
    const socket = createConnection(endpoint);
    const decoder = new BrowserUseFrameDecoder({
      maxFrameBytes: BROWSER_CLI_MAX_RESPONSE_BYTES,
      maxInputChunkBytes: BROWSER_CLI_MAX_RESPONSE_BYTES + 4,
      maxMessagesPerInputChunk: 1,
      maxRetainedInputBytes: BROWSER_CLI_MAX_RESPONSE_BYTES + 4,
      maxRetainedInputChunks: 256,
    });
    const chunks: Buffer[] = [];
    let bytes = 0;
    let settled = false;
    const timer = setTimeout(
      () => finish(new Error('Browser relay timed out')),
      RELAY_TIMEOUT_MS,
    );
    timer.unref();
    const abort = (): void => finish(new Error('Browser relay was cancelled'));
    const finish = (error?: Error, response?: Buffer): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
      decoder.clear();
      socket.destroy();
      if (error) reject(error);
      else resolve(response!);
    };
    signal?.addEventListener('abort', abort, { once: true });
    socket.once('connect', () => socket.write(request));
    socket.on('data', (chunk: Buffer) => {
      try {
        bytes += chunk.byteLength;
        if (bytes > BROWSER_CLI_MAX_RESPONSE_BYTES + 4) {
          throw new Error('Browser relay response exceeded its limit');
        }
        chunks.push(Buffer.from(chunk));
        const messages = decoder.push(chunk);
        if (messages.length === 1) finish(undefined, Buffer.concat(chunks));
      } catch (error) {
        finish(error instanceof Error ? error : new Error('Browser relay response was invalid'));
      }
    });
    socket.once('error', () => finish(new Error('Browser relay is unavailable')));
    socket.once('close', () => {
      if (!settled) finish(new Error('Browser relay closed before responding'));
    });
  });
}
