import { endianness } from 'node:os';

const FRAME_HEADER_BYTES = 4;
const DEFAULT_MAX_FRAME_BYTES = 8 * 1024 * 1024;
const LITTLE_ENDIAN = endianness() === 'LE';

export type JsonRpcId = number | string;

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

export function encodeBrowserUseFrame(message: unknown): Buffer {
  const payload = Buffer.from(JSON.stringify(message), 'utf8');
  if (payload.byteLength > DEFAULT_MAX_FRAME_BYTES) {
    throw new Error(`Browser-use message exceeds ${DEFAULT_MAX_FRAME_BYTES} bytes.`);
  }
  const frame = Buffer.allocUnsafe(FRAME_HEADER_BYTES + payload.byteLength);
  writeFrameLength(frame, payload.byteLength);
  payload.copy(frame, FRAME_HEADER_BYTES);
  return frame;
}

export class BrowserUseFrameDecoder {
  private buffered = Buffer.alloc(0);

  constructor(private readonly maxFrameBytes = DEFAULT_MAX_FRAME_BYTES) {}

  push(chunk: Uint8Array): unknown[] {
    if (chunk.byteLength === 0) return [];
    this.buffered = Buffer.concat([
      this.buffered,
      Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength),
    ]);

    const messages: unknown[] = [];
    while (this.buffered.byteLength >= FRAME_HEADER_BYTES) {
      const payloadLength = readFrameLength(this.buffered);
      if (payloadLength > this.maxFrameBytes) {
        throw new Error(`Browser-use frame exceeds ${this.maxFrameBytes} bytes.`);
      }
      const frameLength = FRAME_HEADER_BYTES + payloadLength;
      if (this.buffered.byteLength < frameLength) break;

      const payload = this.buffered
        .subarray(FRAME_HEADER_BYTES, frameLength)
        .toString('utf8');
      this.buffered = this.buffered.subarray(frameLength);
      messages.push(JSON.parse(payload));
    }
    return messages;
  }
}

export function isJsonRpcRequest(value: unknown): value is JsonRpcRequest {
  if (value == null || typeof value !== 'object' || Array.isArray(value)) return false;
  const candidate = value as Partial<JsonRpcRequest>;
  return candidate.jsonrpc === '2.0' && typeof candidate.method === 'string';
}
