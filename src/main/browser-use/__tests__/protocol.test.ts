import { endianness } from 'node:os';

import { describe, expect, it } from 'vitest';

import {
  BrowserUseFrameDecoder,
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

    expect(decoder.push(first.subarray(0, 3))).toEqual([]);
    expect(decoder.push(Buffer.concat([first.subarray(3), second]))).toEqual([
      { jsonrpc: '2.0', id: 1, method: 'ping' },
      { jsonrpc: '2.0', id: 2, method: 'getTabs' },
    ]);
  });

  it('rejects oversized inbound frames before waiting for their payload', () => {
    const header = Buffer.alloc(4);
    if (endianness() === 'LE') header.writeUInt32LE(17, 0);
    else header.writeUInt32BE(17, 0);

    expect(() => new BrowserUseFrameDecoder(16).push(header)).toThrow(
      'Browser-use frame exceeds 16 bytes.',
    );
  });

  it('accepts only JSON-RPC method messages as requests', () => {
    expect(isJsonRpcRequest({ jsonrpc: '2.0', method: 'ping' })).toBe(true);
    expect(isJsonRpcRequest({ jsonrpc: '2.0', id: 1, result: 'pong' })).toBe(false);
    expect(isJsonRpcRequest({ jsonrpc: '1.0', method: 'ping' })).toBe(false);
  });
});
