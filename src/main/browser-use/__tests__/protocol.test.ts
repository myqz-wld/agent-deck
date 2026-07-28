import { endianness } from 'node:os';

import { describe, expect, it, vi } from 'vitest';

import {
  BrowserUseFrameDecoder,
  BrowserUseTransportLimitError,
  encodeBrowserUseFrame,
  isJsonRpcRequest,
} from '../protocol';

describe('browser-use framing protocol', () => {
  it('encodes a native-endian uint32 length followed by UTF-8 JSON', () => {
    const message = {
      jsonrpc: '2.0',
      id: 7,
      method: 'getInfo',
      params: { session_id: 'session-a' },
    };
    const frame = encodeBrowserUseFrame(message);
    const payloadLength =
      endianness() === 'LE' ? frame.readUInt32LE(0) : frame.readUInt32BE(0);

    expect(payloadLength).toBe(frame.byteLength - 4);
    expect(JSON.parse(frame.subarray(4).toString('utf8'))).toEqual(message);
  });

  it('decodes split and coalesced frames without losing buffered bytes', () => {
    const first = encodeBrowserUseFrame({ jsonrpc: '2.0', id: 1, method: 'ping' });
    const second = encodeBrowserUseFrame({
      jsonrpc: '2.0',
      id: 2,
      method: 'getTabs',
    });
    const decoder = new BrowserUseFrameDecoder();
    const concat = vi.spyOn(Buffer, 'concat');

    expect(decoder.push(first.subarray(0, 3))).toEqual([]);
    expect(decoder.push(Buffer.concat([first.subarray(3), second]))).toEqual([
      { jsonrpc: '2.0', id: 1, method: 'ping' },
      { jsonrpc: '2.0', id: 2, method: 'getTabs' },
    ]);
    expect(decoder.retainedBytes).toBe(0);
    expect(concat).toHaveBeenCalledOnce();
    concat.mockRestore();
  });

  it('rejects oversized inbound frames before waiting for their payload', () => {
    const header = Buffer.alloc(4);
    if (endianness() === 'LE') header.writeUInt32LE(17, 0);
    else header.writeUInt32BE(17, 0);

    expect(() => new BrowserUseFrameDecoder({ maxFrameBytes: 16 }).push(header)).toThrow(
      BrowserUseTransportLimitError,
    );
    expect(() => new BrowserUseFrameDecoder({ maxFrameBytes: 16 }).push(header)).toThrow(
      'Browser transport resource limit exceeded.',
    );
  });

  it('bounds individual input chunks and retained incomplete frame bytes', () => {
    const chunkBounded = new BrowserUseFrameDecoder({
      maxFrameBytes: 64,
      maxInputChunkBytes: 8,
      maxRetainedInputBytes: 68,
    });
    expect(() => chunkBounded.push(Buffer.alloc(9))).toThrow(
      'Browser transport resource limit exceeded.',
    );
    expect(chunkBounded.retainedBytes).toBe(0);

    const retainedBounded = new BrowserUseFrameDecoder({
      maxFrameBytes: 64,
      maxInputChunkBytes: 8,
      maxRetainedInputBytes: 8,
    });
    const header = Buffer.alloc(4);
    if (endianness() === 'LE') header.writeUInt32LE(12, 0);
    else header.writeUInt32BE(12, 0);
    retainedBounded.push(Buffer.concat([header, Buffer.alloc(4)]));
    expect(retainedBounded.retainedBytes).toBe(8);
    expect(() => retainedBounded.push(Buffer.alloc(1))).toThrow(
      'Browser transport resource limit exceeded.',
    );
    expect(retainedBounded.retainedBytes).toBe(0);

    const chunkCountBounded = new BrowserUseFrameDecoder({
      maxFrameBytes: 64,
      maxInputChunkBytes: 8,
      maxRetainedInputBytes: 68,
      maxRetainedInputChunks: 2,
    });
    chunkCountBounded.push(header);
    chunkCountBounded.push(Buffer.alloc(1));
    expect(() => chunkCountBounded.push(Buffer.alloc(1))).toThrow(
      'Browser transport resource limit exceeded.',
    );
  });

  it('rejects encoded output before allocating an oversized frame', () => {
    expect(() =>
      encodeBrowserUseFrame(
        { jsonrpc: '2.0', id: 1, result: 'x'.repeat(256) },
        96,
      ),
    ).toThrow('Browser transport resource limit exceeded.');
  });

  it('bounds decoded messages from one input chunk', () => {
    const decoder = new BrowserUseFrameDecoder({
      maxMessagesPerInputChunk: 2,
    });
    const frame = encodeBrowserUseFrame({ jsonrpc: '2.0', method: 'ping' });

    expect(() => decoder.push(Buffer.concat([frame, frame, frame]))).toThrow(
      'Browser transport resource limit exceeded.',
    );
    expect(decoder.retainedBytes).toBe(0);
  });

  it('accepts only JSON-RPC method messages as requests', () => {
    expect(isJsonRpcRequest({ jsonrpc: '2.0', method: 'ping' })).toBe(true);
    expect(isJsonRpcRequest({ jsonrpc: '2.0', id: null, method: 'ping' })).toBe(true);
    expect(isJsonRpcRequest({ jsonrpc: '2.0', id: 1, result: 'pong' })).toBe(false);
    expect(isJsonRpcRequest({ jsonrpc: '2.0', id: {}, method: 'ping' })).toBe(false);
    expect(isJsonRpcRequest({ jsonrpc: '1.0', method: 'ping' })).toBe(false);
  });
});
