import { endianness } from 'node:os';

import { DEFAULT_BROWSER_USE_TRANSPORT_LIMITS } from './transport-limits';

const FRAME_HEADER_BYTES = 4;
const LITTLE_ENDIAN = endianness() === 'LE';
const RESOURCE_LIMIT_MESSAGE = 'Browser transport resource limit exceeded.';
const PROTOCOL_ERROR_MESSAGE = 'Browser transport protocol error.';

export type JsonRpcId = number | string | null;

export interface JsonRpcRequest {
  jsonrpc: '2.0';
  id?: JsonRpcId;
  method: string;
  params?: unknown;
}

export interface JsonRpcResponse {
  jsonrpc: '2.0';
  id: JsonRpcId;
  result?: unknown;
  error?: {
    code: number;
    message: string;
  };
}

export type BrowserUseTransportLimitReason =
  | 'input-buffer-limit'
  | 'input-chunk-limit'
  | 'input-frame-limit'
  | 'input-message-limit'
  | 'output-frame-limit';

export class BrowserUseTransportLimitError extends Error {
  constructor(readonly reason: BrowserUseTransportLimitReason) {
    super(RESOURCE_LIMIT_MESSAGE);
    this.name = 'BrowserUseTransportLimitError';
  }
}

export class BrowserUseProtocolError extends Error {
  constructor() {
    super(PROTOCOL_ERROR_MESSAGE);
    this.name = 'BrowserUseProtocolError';
  }
}

export interface BrowserUseFrameDecoderOptions {
  maxFrameBytes?: number;
  maxInputChunkBytes?: number;
  maxMessagesPerInputChunk?: number;
  maxRetainedInputBytes?: number;
  maxRetainedInputChunks?: number;
}

function readFrameLength(buffer: Buffer): number {
  return LITTLE_ENDIAN ? buffer.readUInt32LE(0) : buffer.readUInt32BE(0);
}

function writeFrameLength(buffer: Buffer, length: number): void {
  if (LITTLE_ENDIAN) {
    buffer.writeUInt32LE(length, 0);
  } else {
    buffer.writeUInt32BE(length, 0);
  }
}

export function encodeBrowserUseFrame(
  message: unknown,
  maxFrameBytes = DEFAULT_BROWSER_USE_TRANSPORT_LIMITS.maxOutputFrameBytes,
): Buffer {
  const serialized = boundedJsonStringify(message, maxFrameBytes);
  const payload = Buffer.from(serialized, 'utf8');
  const frame = Buffer.allocUnsafe(FRAME_HEADER_BYTES + payload.byteLength);
  writeFrameLength(frame, payload.byteLength);
  payload.copy(frame, FRAME_HEADER_BYTES);
  return frame;
}

export class BrowserUseFrameDecoder {
  private readonly chunks: Array<Buffer | undefined> = [];
  private readonly header = Buffer.allocUnsafe(FRAME_HEADER_BYTES);
  private readonly maxFrameBytes: number;
  private readonly maxInputChunkBytes: number;
  private readonly maxMessagesPerInputChunk: number;
  private readonly maxRetainedInputBytes: number;
  private readonly maxRetainedInputChunks: number;
  private headIndex = 0;
  private headOffset = 0;
  private retained = 0;

  constructor(options: BrowserUseFrameDecoderOptions = {}) {
    this.maxFrameBytes =
      options.maxFrameBytes ?? DEFAULT_BROWSER_USE_TRANSPORT_LIMITS.maxFrameBytes;
    this.maxInputChunkBytes =
      options.maxInputChunkBytes ??
      DEFAULT_BROWSER_USE_TRANSPORT_LIMITS.maxInputChunkBytes;
    this.maxMessagesPerInputChunk =
      options.maxMessagesPerInputChunk ??
      DEFAULT_BROWSER_USE_TRANSPORT_LIMITS.maxMessagesPerInputChunk;
    this.maxRetainedInputBytes =
      options.maxRetainedInputBytes ??
      DEFAULT_BROWSER_USE_TRANSPORT_LIMITS.maxRetainedInputBytes;
    this.maxRetainedInputChunks =
      options.maxRetainedInputChunks ??
      DEFAULT_BROWSER_USE_TRANSPORT_LIMITS.maxRetainedInputChunks;
  }

  get retainedBytes(): number {
    return this.retained;
  }

  push(chunk: Uint8Array): unknown[] {
    if (chunk.byteLength === 0) return [];
    if (chunk.byteLength > this.maxInputChunkBytes) {
      return this.fail(new BrowserUseTransportLimitError('input-chunk-limit'));
    }
    const messages: unknown[] = [];
    try {
      let offset = 0;
      while (offset < chunk.byteLength) {
        const available = this.maxRetainedInputBytes - this.retained;
        if (available <= 0) {
          throw new BrowserUseTransportLimitError('input-buffer-limit');
        }
        const count = Math.min(available, chunk.byteLength - offset);
        this.append(chunk.subarray(offset, offset + count));
        offset += count;
        this.parseAvailable(messages);
      }
      return messages;
    } catch (error) {
      this.clear();
      throw error;
    }
  }

  private append(chunk: Uint8Array): void {
    if (this.chunks.length - this.headIndex >= this.maxRetainedInputChunks) {
      throw new BrowserUseTransportLimitError('input-buffer-limit');
    }
    this.chunks.push(Buffer.from(chunk));
    this.retained += chunk.byteLength;
  }

  private parseAvailable(messages: unknown[]): void {
    while (this.retained >= FRAME_HEADER_BYTES) {
      this.copyRetained(this.header, FRAME_HEADER_BYTES);
      const payloadLength = readFrameLength(this.header);
      if (payloadLength > this.maxFrameBytes) {
        throw new BrowserUseTransportLimitError('input-frame-limit');
      }
      const frameLength = FRAME_HEADER_BYTES + payloadLength;
      if (this.retained < frameLength) return;

      this.consume(FRAME_HEADER_BYTES);
      const payload = Buffer.allocUnsafe(payloadLength);
      this.consume(payloadLength, payload);
      if (messages.length >= this.maxMessagesPerInputChunk) {
        throw new BrowserUseTransportLimitError('input-message-limit');
      }
      try {
        messages.push(JSON.parse(payload.toString('utf8')));
      } catch {
        throw new BrowserUseProtocolError();
      }
    }
  }

  clear(): void {
    this.chunks.length = 0;
    this.headIndex = 0;
    this.headOffset = 0;
    this.retained = 0;
  }

  private copyRetained(target: Buffer, length: number): void {
    let targetOffset = 0;
    let index = this.headIndex;
    let offset = this.headOffset;
    while (targetOffset < length) {
      const source = this.chunks[index];
      if (source == null) throw new BrowserUseProtocolError();
      const available = source.byteLength - offset;
      const count = Math.min(available, length - targetOffset);
      source.copy(target, targetOffset, offset, offset + count);
      targetOffset += count;
      index += 1;
      offset = 0;
    }
  }

  private consume(length: number, target?: Buffer): void {
    let remaining = length;
    let targetOffset = 0;
    while (remaining > 0) {
      const source = this.chunks[this.headIndex];
      if (source == null) throw new BrowserUseProtocolError();
      const available = source.byteLength - this.headOffset;
      const count = Math.min(available, remaining);
      if (target != null) {
        source.copy(target, targetOffset, this.headOffset, this.headOffset + count);
      }
      this.headOffset += count;
      this.retained -= count;
      remaining -= count;
      targetOffset += count;
      if (this.headOffset === source.byteLength) {
        this.chunks[this.headIndex] = undefined;
        this.headIndex += 1;
        this.headOffset = 0;
      }
    }
    if (this.headIndex >= 32 && this.headIndex * 2 >= this.chunks.length) {
      this.chunks.splice(0, this.headIndex);
      this.headIndex = 0;
    }
  }

  private fail(error: BrowserUseTransportLimitError): never {
    this.clear();
    throw error;
  }
}

export function isJsonRpcRequest(value: unknown): value is JsonRpcRequest {
  if (value == null || typeof value !== 'object' || Array.isArray(value)) return false;
  const candidate = value as Partial<JsonRpcRequest>;
  return candidate.jsonrpc === '2.0'
    && typeof candidate.method === 'string'
    && (
      candidate.id === undefined
      || candidate.id === null
      || typeof candidate.id === 'number'
      || typeof candidate.id === 'string'
    );
}

function boundedJsonStringify(value: unknown, maxBytes: number): string {
  if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0) {
    throw new BrowserUseTransportLimitError('output-frame-limit');
  }
  let estimatedBytes = 0;
  const add = (bytes: number): void => {
    estimatedBytes += bytes;
    if (estimatedBytes > maxBytes) {
      throw new BrowserUseTransportLimitError('output-frame-limit');
    }
  };

  let serialized: string | undefined;
  try {
    serialized = JSON.stringify(value, function budgetJson(key, candidate) {
      if (key !== '') {
        add(Array.isArray(this) ? 1 : escapedJsonStringBytes(key) + 2);
      }
      if (candidate === null) add(4);
      else {
        switch (typeof candidate) {
          case 'string':
            add(escapedJsonStringBytes(candidate));
            break;
          case 'number':
            add(Number.isFinite(candidate) ? Buffer.byteLength(String(candidate)) : 4);
            break;
          case 'boolean':
            add(candidate ? 4 : 5);
            break;
          case 'undefined':
          case 'function':
          case 'symbol':
            add(4);
            break;
          case 'bigint':
            throw new BrowserUseProtocolError();
          case 'object':
            add(2);
            break;
        }
      }
      return candidate;
    });
  } catch (error) {
    if (
      error instanceof BrowserUseTransportLimitError
      || error instanceof BrowserUseProtocolError
    ) {
      throw error;
    }
    throw new BrowserUseProtocolError();
  }
  if (serialized == null) throw new BrowserUseProtocolError();
  if (Buffer.byteLength(serialized, 'utf8') > maxBytes) {
    throw new BrowserUseTransportLimitError('output-frame-limit');
  }
  return serialized;
}

function escapedJsonStringBytes(value: string): number {
  let bytes = 2;
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code === 0x22 || code === 0x5c) {
      bytes += 2;
    } else if (code <= 0x1f) {
      bytes += code === 0x08 || code === 0x09 || code === 0x0a
        || code === 0x0c || code === 0x0d
        ? 2
        : 6;
    } else if (code <= 0x7f) {
      bytes += 1;
    } else if (code <= 0x7ff) {
      bytes += 2;
    } else if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        bytes += 4;
        index += 1;
      } else {
        bytes += 6;
      }
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      bytes += 6;
    } else {
      bytes += 3;
    }
  }
  return bytes;
}
