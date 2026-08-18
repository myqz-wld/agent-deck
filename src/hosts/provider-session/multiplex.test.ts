import { Duplex, PassThrough } from 'node:stream';
import { describe, expect, it, vi } from 'vitest';

import { ProviderSessionMultiplexConnection } from './multiplex';

function pair() {
  const coreToShim = new PassThrough();
  const shimToCore = new PassThrough();
  return {
    core: Duplex.from({ readable: shimToCore, writable: coreToShim }),
    shim: Duplex.from({ readable: coreToShim, writable: shimToCore }),
  };
}

function request(requestId = 'request-a') {
  return {
    schemaVersion: 1 as const,
    body: { messages: [{ role: 'user', content: 'hello' }], stream: true },
    deadlineMs: 30_000,
    method: 'POST' as const,
    path: '/v1/chat/completions',
    requestId,
  };
}

function cancelFrame(id: number): Buffer {
  const frame = Buffer.alloc(12);
  frame.writeUInt8(0x41, 0);
  frame.writeUInt8(0x44, 1);
  frame.writeUInt8(1, 2);
  frame.writeUInt8(4, 3);
  frame.writeUInt32BE(id, 4);
  frame.writeUInt32BE(0, 8);
  return frame;
}

describe('Provider session stdio multiplex protocol', () => {
  it('carries independent ACP bytes and one exact inference response', async () => {
    const streams = pair();
    const core = new ProviderSessionMultiplexConnection({
      role: 'core',
      stream: streams.core,
      invoke: async (input) => ({
        schemaVersion: 1,
        body: `data: ${JSON.stringify(input.body)}\n\ndata: [DONE]\n\n`,
        contentType: 'text/event-stream',
        requestId: input.requestId,
        statusCode: 200,
      }),
    });
    const shim = new ProviderSessionMultiplexConnection({ role: 'shim', stream: streams.shim });
    const atShim = new Promise<string>((resolve) => shim.acp.once('data', (value: Buffer) =>
      resolve(value.toString('utf8'))));
    const atCore = new Promise<string>((resolve) => core.acp.once('data', (value: Buffer) =>
      resolve(value.toString('utf8'))));
    core.acp.write(Buffer.from('{"method":"initialize"}\n'));
    shim.acp.write(Buffer.from('{"result":"ready"}\n'));
    await expect(atShim).resolves.toBe('{"method":"initialize"}\n');
    await expect(atCore).resolves.toBe('{"result":"ready"}\n');
    await expect(shim.requestInference(request())).resolves.toMatchObject({
      contentType: 'text/event-stream',
      requestId: 'request-a',
      statusCode: 200,
    });
    await Promise.all([core.close(), shim.close()]);
  });

  it('relays one bounded opaque Browser CLI frame without mixing it with ACP or inference', async () => {
    const streams = pair();
    const invokeBrowser = vi.fn(async (input: Buffer) =>
      Buffer.concat([Buffer.from('response:'), input]));
    const core = new ProviderSessionMultiplexConnection({
      role: 'core',
      stream: streams.core,
      invoke: async (input) => ({
        schemaVersion: 1,
        body: '{}',
        contentType: 'application/json',
        requestId: input.requestId,
        statusCode: 200,
      }),
      invokeBrowser,
    });
    const shim = new ProviderSessionMultiplexConnection({ role: 'shim', stream: streams.shim });

    await expect(shim.requestBrowser(Buffer.from('browser-frame')))
      .resolves.toEqual(Buffer.from('response:browser-frame'));
    expect(invokeBrowser).toHaveBeenCalledWith(
      Buffer.from('browser-frame'),
      expect.any(AbortSignal),
    );
    await Promise.all([core.close(), shim.close()]);
  });

  it('cancels an in-flight Core invocation without leaking an error payload', async () => {
    const streams = pair();
    let observed!: AbortSignal;
    const core = new ProviderSessionMultiplexConnection({
      role: 'core',
      stream: streams.core,
      invoke: async (_input, signal) => {
        observed = signal;
        return new Promise((_, reject) => signal.addEventListener('abort', () => reject(
          new Error('cancelled'),
        ), { once: true }));
      },
    });
    const shim = new ProviderSessionMultiplexConnection({ role: 'shim', stream: streams.shim });
    const controller = new AbortController();
    const pending = shim.requestInference(request(), controller.signal);
    while (!observed) await new Promise<void>((resolve) => setImmediate(resolve));
    controller.abort();
    await expect(pending).rejects.toThrow('failed closed');
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(observed.aborted).toBe(true);
    await Promise.all([core.close(), shim.close()]);
  });

  it('accepts a bounded late cancel after the request deadline domain elapsed', async () => {
    const streams = pair();
    const core = new ProviderSessionMultiplexConnection({
      role: 'core',
      stream: streams.core,
      invoke: async (input) => ({
        schemaVersion: 1,
        body: '{}',
        contentType: 'application/json',
        requestId: input.requestId,
        statusCode: 200,
      }),
    });
    const shim = new ProviderSessionMultiplexConnection({ role: 'shim', stream: streams.shim });
    await expect(shim.requestInference(request())).resolves.toMatchObject({ requestId: 'request-a' });
    await new Promise<void>((resolve) => setImmediate(resolve));
    vi.useFakeTimers();
    vi.advanceTimersByTime(120_000);
    vi.useRealTimers();
    streams.shim.write(cancelFrame(1));
    await new Promise<void>((resolve) => setImmediate(resolve));
    await expect(shim.requestInference(request('request-b'))).resolves.toMatchObject({
      requestId: 'request-b',
    });
    await Promise.all([core.close(), shim.close()]);
  });

  it('rejects role confusion before any untrusted frame is accepted', () => {
    const streams = pair();
    expect(() => new ProviderSessionMultiplexConnection({
      role: 'shim',
      stream: streams.shim,
      invoke: async () => ({
        schemaVersion: 1, body: '', contentType: 'application/json',
        requestId: 'request-a', statusCode: 200,
      }),
    })).toThrow('role');
  });
});
