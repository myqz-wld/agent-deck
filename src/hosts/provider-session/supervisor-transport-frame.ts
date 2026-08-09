import type { Duplex } from 'node:stream';

import { PROVIDER_SESSION_SUPERVISOR_MAX_FRAME_BYTES } from './supervisor-transport-contract';

const decoder = new TextDecoder('utf-8', { fatal: true });

export function encodeProviderSessionSupervisorFrame(value: unknown): Buffer {
  let encoded: string;
  try {
    encoded = JSON.stringify(value);
  } catch {
    throw new Error('provider supervisor transport frame is not JSON');
  }
  const frame = Buffer.from(`${encoded}\n`, 'utf8');
  if (frame.byteLength > PROVIDER_SESSION_SUPERVISOR_MAX_FRAME_BYTES) {
    throw new Error('provider supervisor transport frame exceeded its bound');
  }
  return frame;
}

export interface ProviderSessionSupervisorFrameWithRemainder {
  readonly remainder: Buffer;
  readonly value: unknown;
}

function readFrame(
  stream: Duplex,
  timeoutMs: number,
  allowRemainder: boolean,
): Promise<ProviderSessionSupervisorFrameWithRemainder> {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 600_000) {
    throw new Error('provider supervisor transport timeout is invalid');
  }
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let bytes = 0;
    let settled = false;
    const timer = setTimeout(() => finish(new Error('provider supervisor transport timed out')),
      timeoutMs);
    timer.unref();

    const cleanup = (): void => {
      clearTimeout(timer);
      stream.removeListener('data', onData);
      stream.removeListener('end', onEnd);
      stream.removeListener('error', onError);
      stream.removeListener('close', onClose);
    };
    const finish = (
      error?: Error,
      value?: ProviderSessionSupervisorFrameWithRemainder,
    ): void => {
      if (settled) return;
      settled = true;
      cleanup();
      if (error) reject(error);
      else if (value) resolve(value);
      else reject(new Error('provider supervisor transport frame is invalid'));
    };
    const parse = (frame: Buffer, remainder: Buffer): void => {
      try {
        const text = decoder.decode(frame);
        finish(undefined, Object.freeze({
          remainder,
          value: JSON.parse(text) as unknown,
        }));
      } catch {
        finish(new Error('provider supervisor transport frame is invalid'));
      }
    };
    const onData = (chunk: unknown): void => {
      if (!Buffer.isBuffer(chunk)) {
        finish(new Error('provider supervisor transport emitted non-byte data'));
        return;
      }
      const newline = chunk.indexOf(0x0a);
      const included = newline === -1 ? chunk : chunk.subarray(0, newline);
      bytes += included.byteLength;
      if (bytes + 1 > PROVIDER_SESSION_SUPERVISOR_MAX_FRAME_BYTES) {
        finish(new Error('provider supervisor transport frame exceeded its bound'));
        return;
      }
      chunks.push(Buffer.from(included));
      if (newline === -1) return;
      if (!allowRemainder && newline !== chunk.byteLength - 1) {
        finish(new Error('provider supervisor transport sent multiple frames'));
        return;
      }
      stream.pause();
      const frame = Buffer.concat(chunks);
      parse(
        frame.at(-1) === 0x0d ? frame.subarray(0, -1) : frame,
        newline === chunk.byteLength - 1
          ? Buffer.alloc(0)
          : Buffer.from(chunk.subarray(newline + 1)),
      );
    };
    const onEnd = (): void => finish(new Error('provider supervisor transport ended early'));
    const onError = (): void => finish(new Error('provider supervisor transport failed'));
    const onClose = (): void => finish(new Error('provider supervisor transport closed early'));

    stream.on('data', onData);
    stream.once('end', onEnd);
    stream.once('error', onError);
    stream.once('close', onClose);
  });
}

export async function readProviderSessionSupervisorFrame(
  stream: Duplex,
  timeoutMs: number,
): Promise<unknown> {
  return (await readFrame(stream, timeoutMs, false)).value;
}

/** Upgrade-only decoder; callers must immediately restore the opaque remainder before relaying. */
export function readProviderSessionSupervisorUpgradeFrame(
  stream: Duplex,
  timeoutMs: number,
): Promise<ProviderSessionSupervisorFrameWithRemainder> {
  return readFrame(stream, timeoutMs, true);
}

export async function writeProviderSessionSupervisorFrame(
  stream: Duplex,
  value: unknown,
): Promise<void> {
  const frame = encodeProviderSessionSupervisorFrame(value);
  await new Promise<void>((resolve, reject) => {
    let settled = false;
    const fail = (): void => {
      if (settled) return;
      settled = true;
      reject(new Error('provider supervisor transport write failed'));
    };
    const onError = (): void => fail();
    stream.once('error', onError);
    try {
      stream.write(frame, (error) => {
        if (error) {
          fail();
          return;
        }
        if (settled) return;
        settled = true;
        stream.removeListener('error', onError);
        resolve();
      });
    } catch {
      fail();
    }
  });
}
