import { Duplex, PassThrough, Writable } from 'node:stream';

import {
  PROVIDER_INFERENCE_BROKER_SCHEMA_VERSION,
  PROVIDER_INFERENCE_MAX_REQUEST_BYTES,
  PROVIDER_INFERENCE_MAX_RESPONSE_BYTES,
  parseProviderInferenceBrokerRequest,
  parseProviderInferenceBrokerResponse,
  type ProviderInferenceBrokerRequest,
  type ProviderInferenceBrokerResponse,
} from '@contracts/index';

export type ProviderSessionMultiplexRole = 'core' | 'shim';

export interface ProviderSessionMultiplexOptions {
  readonly invoke?: (
    request: ProviderInferenceBrokerRequest,
    signal: AbortSignal,
  ) => Promise<ProviderInferenceBrokerResponse>;
  readonly invokeBrowser?: (request: Buffer, signal: AbortSignal) => Promise<Buffer>;
  readonly role: ProviderSessionMultiplexRole;
  readonly stream: Duplex;
}

interface PendingRequest {
  readonly abort?: () => void;
  readonly reject: (error: Error) => void;
  readonly requestId: string;
  readonly resolve: (response: ProviderInferenceBrokerResponse) => void;
  readonly signal?: AbortSignal;
  readonly timer: ReturnType<typeof setTimeout>;
}

interface ActiveRequest {
  readonly controller: AbortController;
  cancelled: boolean;
}

interface RetiredRequest {
  readonly kind: 'browser' | 'inference';
  readonly requestId?: string;
}

interface PendingBrowserRequest {
  readonly abort?: () => void;
  readonly reject: (error: Error) => void;
  readonly resolve: (response: Buffer) => void;
  readonly signal?: AbortSignal;
  readonly timer: ReturnType<typeof setTimeout>;
}

const MAGIC = Buffer.from([0x41, 0x44]);
const VERSION = 1;
const HEADER_BYTES = 12;
const MAX_ACP_FRAME_BYTES = 1024 * 1024;
const MAX_FRAME_BYTES = PROVIDER_INFERENCE_MAX_RESPONSE_BYTES + 4 * 1024;
const MAX_MULTIPLEX_REQUESTS = 8;
const MAX_RETIRED_REQUESTS = MAX_MULTIPLEX_REQUESTS * 2;
const RESPONSE_HEADER_BYTES = 2 * 1024;
const MAX_BROWSER_REQUEST_BYTES = 128 * 1024 + 4;
const MAX_BROWSER_RESPONSE_BYTES = 2 * 1024 * 1024 + 4;
const BROWSER_TIMEOUT_MS = 40_000;
const FRAME = Object.freeze({
  acp: 1,
  request: 2,
  response: 3,
  cancel: 4,
  browserRequest: 5,
  browserResponse: 6,
  browserCancel: 7,
} as const);
const decoder = new TextDecoder('utf-8', { fatal: true });

function protocolError(): Error {
  return new Error('provider session multiplex protocol failed closed');
}

function encodedFrame(kind: number, id: number, payload: Buffer): Buffer {
  if (!Number.isSafeInteger(id) || id < 0 || id > 0xffff_ffff ||
      payload.byteLength > MAX_FRAME_BYTES) throw protocolError();
  const header = Buffer.allocUnsafe(HEADER_BYTES);
  MAGIC.copy(header, 0);
  header.writeUInt8(VERSION, 2);
  header.writeUInt8(kind, 3);
  header.writeUInt32BE(id, 4);
  header.writeUInt32BE(payload.byteLength, 8);
  return Buffer.concat([header, payload]);
}

function responsePayload(responseValue: ProviderInferenceBrokerResponse): Buffer {
  const response = parseProviderInferenceBrokerResponse(responseValue);
  const body = Buffer.from(response.body, 'utf8');
  const header = Buffer.from(JSON.stringify({
    schemaVersion: response.schemaVersion,
    bodyBytes: body.byteLength,
    contentType: response.contentType,
    requestId: response.requestId,
    statusCode: response.statusCode,
  }), 'utf8');
  if (header.byteLength > RESPONSE_HEADER_BYTES) throw protocolError();
  return Buffer.concat([header, Buffer.from('\n'), body]);
}

function parsedResponsePayload(payload: Buffer): ProviderInferenceBrokerResponse {
  const boundary = payload.indexOf(0x0a);
  if (boundary < 2 || boundary > RESPONSE_HEADER_BYTES) throw protocolError();
  const raw = JSON.parse(decoder.decode(payload.subarray(0, boundary))) as Record<string, unknown>;
  const keys = Object.keys(raw).sort();
  if (keys.join(',') !== 'bodyBytes,contentType,requestId,schemaVersion,statusCode' ||
      !Number.isSafeInteger(raw.bodyBytes) || (raw.bodyBytes as number) < 0 ||
      raw.bodyBytes !== payload.byteLength - boundary - 1) throw protocolError();
  return parseProviderInferenceBrokerResponse({
    schemaVersion: raw.schemaVersion,
    body: decoder.decode(payload.subarray(boundary + 1)),
    contentType: raw.contentType,
    requestId: raw.requestId,
    statusCode: raw.statusCode,
  });
}

function failureResponse(requestId: string): ProviderInferenceBrokerResponse {
  return Object.freeze({
    schemaVersion: PROVIDER_INFERENCE_BROKER_SCHEMA_VERSION,
    body: '{"error":"provider_session_broker_unavailable"}',
    contentType: 'application/json',
    requestId,
    statusCode: 502,
  });
}

/** Binary, bounded ACP/inference multiplexing for Desktop-VM containers with no usable UDS mount. */
export class ProviderSessionMultiplexConnection {
  readonly acp: Duplex;
  private readonly acpInput = new PassThrough({ highWaterMark: MAX_ACP_FRAME_BYTES });
  private readonly active = new Map<number, ActiveRequest>();
  private readonly activeBrowser = new Map<number, ActiveRequest>();
  private readonly pending = new Map<number, PendingRequest>();
  private readonly pendingBrowser = new Map<number, PendingBrowserRequest>();
  private readonly retired = new Map<number, RetiredRequest>();
  private buffer = Buffer.alloc(0);
  private closed = false;
  private nextRequestId = 1;

  constructor(private readonly options: ProviderSessionMultiplexOptions) {
    if ((options.role === 'core') !== (typeof options.invoke === 'function')) {
      throw new Error('provider session multiplex role is invalid');
    }
    if (options.role === 'shim' && options.invokeBrowser !== undefined) {
      throw new Error('provider session multiplex Browser role is invalid');
    }
    const output = new Writable({
      highWaterMark: MAX_ACP_FRAME_BYTES,
      write: (chunk: Buffer, _encoding, done) => {
        void this.writeAcp(chunk).then(() => done(), done);
      },
    });
    this.acp = Duplex.from({ readable: this.acpInput, writable: output });
    this.acp.on('error', () => undefined);
    options.stream.on('data', (chunk: Buffer) => this.receive(chunk));
    options.stream.once('error', () => this.fail(protocolError()));
    options.stream.once('close', () => this.fail(protocolError()));
    options.stream.once('end', () => this.fail(protocolError()));
  }

  async requestInference(
    value: ProviderInferenceBrokerRequest,
    signal?: AbortSignal,
  ): Promise<ProviderInferenceBrokerResponse> {
    if (this.options.role !== 'shim' || this.closed || this.pending.size >= MAX_MULTIPLEX_REQUESTS) {
      throw protocolError();
    }
    if (signal?.aborted) throw protocolError();
    const request = parseProviderInferenceBrokerRequest(value);
    const id = this.allocateRequestId();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => this.cancelPending(id, protocolError()),
        request.deadlineMs + 1_000);
      timer.unref();
      const abort = (): void => this.cancelPending(id, protocolError());
      const pending: PendingRequest = {
        abort: signal ? abort : undefined,
        reject,
        requestId: request.requestId,
        resolve,
        signal,
        timer,
      };
      this.pending.set(id, pending);
      signal?.addEventListener('abort', abort, { once: true });
      void this.send(FRAME.request, id, Buffer.from(JSON.stringify(request), 'utf8')).catch((error) => {
        this.cancelPending(id, error instanceof Error ? error : protocolError());
      });
    });
  }

  async requestBrowser(value: Buffer, signal?: AbortSignal): Promise<Buffer> {
    if (this.options.role !== 'shim' || this.closed ||
        this.pendingBrowser.size >= MAX_MULTIPLEX_REQUESTS ||
        !Buffer.isBuffer(value) || value.byteLength === 0 ||
        value.byteLength > MAX_BROWSER_REQUEST_BYTES || signal?.aborted) {
      throw protocolError();
    }
    const id = this.allocateRequestId();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(
        () => this.cancelPendingBrowser(id, protocolError()),
        BROWSER_TIMEOUT_MS,
      );
      timer.unref();
      const abort = (): void => this.cancelPendingBrowser(id, protocolError());
      this.pendingBrowser.set(id, {
        abort: signal ? abort : undefined,
        reject,
        resolve,
        signal,
        timer,
      });
      signal?.addEventListener('abort', abort, { once: true });
      void this.send(FRAME.browserRequest, id, value).catch((error) => {
        this.cancelPendingBrowser(id, error instanceof Error ? error : protocolError());
      });
    });
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.rejectAll(protocolError());
    for (const active of this.active.values()) active.controller.abort();
    this.active.clear();
    for (const active of this.activeBrowser.values()) active.controller.abort();
    this.activeBrowser.clear();
    this.clearRetired();
    this.acpInput.end();
    this.acp.destroy();
    this.options.stream.destroy();
  }

  private allocateRequestId(): number {
    for (let attempts = 0; attempts < MAX_MULTIPLEX_REQUESTS + 1; attempts += 1) {
      const selected = this.nextRequestId;
      this.nextRequestId = selected === 0xffff_ffff ? 1 : selected + 1;
      if (!this.pending.has(selected) && !this.pendingBrowser.has(selected) &&
          !this.retired.has(selected)) return selected;
    }
    throw protocolError();
  }

  private cancelPending(id: number, error: Error): void {
    const pending = this.pending.get(id);
    if (!pending) return;
    this.pending.delete(id);
    clearTimeout(pending.timer);
    if (pending.abort) pending.signal?.removeEventListener('abort', pending.abort);
    this.retireRequest(id, 'inference', pending.requestId);
    pending.reject(error);
    void this.send(FRAME.cancel, id, Buffer.alloc(0)).catch(() => undefined);
  }

  private cancelPendingBrowser(id: number, error: Error): void {
    const pending = this.pendingBrowser.get(id);
    if (!pending) return;
    this.pendingBrowser.delete(id);
    clearTimeout(pending.timer);
    if (pending.abort) pending.signal?.removeEventListener('abort', pending.abort);
    this.retireRequest(id, 'browser');
    pending.reject(error);
    void this.send(FRAME.browserCancel, id, Buffer.alloc(0)).catch(() => undefined);
  }

  private receive(chunk: Buffer): void {
    if (this.closed || !Buffer.isBuffer(chunk) || chunk.byteLength === 0) {
      this.fail(protocolError());
      return;
    }
    try {
      let offset = 0;
      while (offset < chunk.byteLength) {
        const capacity = MAX_FRAME_BYTES + HEADER_BYTES - this.buffer.byteLength;
        if (capacity <= 0) throw protocolError();
        const selected = chunk.subarray(offset, offset + capacity);
        this.buffer = this.buffer.byteLength === 0
          ? Buffer.from(selected)
          : Buffer.concat([this.buffer, selected]);
        offset += selected.byteLength;
        this.drainFrames();
      }
    } catch {
      this.fail(protocolError());
    }
  }

  private drainFrames(): void {
    while (this.buffer.byteLength >= HEADER_BYTES) {
      if (!this.buffer.subarray(0, 2).equals(MAGIC) ||
          this.buffer.readUInt8(2) !== VERSION) throw protocolError();
      const kind = this.buffer.readUInt8(3);
      const id = this.buffer.readUInt32BE(4);
      const bytes = this.buffer.readUInt32BE(8);
      if (bytes > MAX_FRAME_BYTES) throw protocolError();
      if (this.buffer.byteLength < HEADER_BYTES + bytes) return;
      const payload = Buffer.from(this.buffer.subarray(HEADER_BYTES, HEADER_BYTES + bytes));
      this.buffer = Buffer.from(this.buffer.subarray(HEADER_BYTES + bytes));
      this.dispatch(kind, id, payload);
    }
  }

  private dispatch(kind: number, id: number, payload: Buffer): void {
    if (kind === FRAME.acp) {
      if (id !== 0 || payload.byteLength > MAX_ACP_FRAME_BYTES) throw protocolError();
      if (!this.acpInput.write(payload)) {
        this.options.stream.pause();
        this.acpInput.once('drain', () => {
          if (!this.closed) this.options.stream.resume();
        });
      }
      return;
    }
    if (kind === FRAME.request && this.options.role === 'core') {
      if (id === 0 || this.active.has(id) || this.activeBrowser.has(id) ||
          this.retired.has(id) ||
          this.active.size >= MAX_MULTIPLEX_REQUESTS ||
          payload.byteLength > PROVIDER_INFERENCE_MAX_REQUEST_BYTES + 2 * 1024) {
        throw protocolError();
      }
      const request = parseProviderInferenceBrokerRequest(JSON.parse(decoder.decode(payload)));
      const active: ActiveRequest = { cancelled: false, controller: new AbortController() };
      this.active.set(id, active);
      void this.options.invoke!(request, active.controller.signal).then(
        (response) => active.cancelled
          ? undefined
          : this.send(FRAME.response, id, responsePayload(response)),
        () => active.cancelled
          ? undefined
          : this.send(FRAME.response, id, responsePayload(failureResponse(request.requestId))),
      ).catch(() => this.fail(protocolError())).finally(() => {
        if (this.active.get(id) === active) {
          this.active.delete(id);
          if (!this.closed) this.retireRequest(id, 'inference', request.requestId);
        }
      });
      return;
    }
    if (kind === FRAME.response && this.options.role === 'shim') {
      const pending = this.pending.get(id);
      if (!pending) {
        const retired = this.retired.get(id);
        if (!retired || retired.kind !== 'inference') throw protocolError();
        const response = parsedResponsePayload(payload);
        if (response.requestId !== retired.requestId) throw protocolError();
        this.retired.delete(id);
        return;
      }
      const response = parsedResponsePayload(payload);
      if (response.requestId !== pending.requestId) throw protocolError();
      this.pending.delete(id);
      clearTimeout(pending.timer);
      if (pending.abort) pending.signal?.removeEventListener('abort', pending.abort);
      pending.resolve(response);
      return;
    }
    if (kind === FRAME.browserRequest && this.options.role === 'core') {
      if (id === 0 || !this.options.invokeBrowser || this.active.has(id) ||
          this.activeBrowser.has(id) || this.retired.has(id) ||
          this.activeBrowser.size >= MAX_MULTIPLEX_REQUESTS ||
          payload.byteLength === 0 || payload.byteLength > MAX_BROWSER_REQUEST_BYTES) {
        throw protocolError();
      }
      const active: ActiveRequest = { cancelled: false, controller: new AbortController() };
      this.activeBrowser.set(id, active);
      void this.options.invokeBrowser(payload, active.controller.signal).then(
        (response) => {
          if (active.cancelled || !Buffer.isBuffer(response) || response.byteLength === 0 ||
              response.byteLength > MAX_BROWSER_RESPONSE_BYTES) return undefined;
          return this.send(FRAME.browserResponse, id, response);
        },
        () => active.cancelled
          ? undefined
          : this.send(FRAME.browserResponse, id, Buffer.alloc(0)),
      ).catch(() => this.fail(protocolError())).finally(() => {
        if (this.activeBrowser.get(id) === active) {
          this.activeBrowser.delete(id);
          if (!this.closed) this.retireRequest(id, 'browser');
        }
      });
      return;
    }
    if (kind === FRAME.browserResponse && this.options.role === 'shim') {
      const pending = this.pendingBrowser.get(id);
      if (!pending) {
        const retired = this.retired.get(id);
        if (!retired || retired.kind !== 'browser' || payload.byteLength === 0 ||
            payload.byteLength > MAX_BROWSER_RESPONSE_BYTES) throw protocolError();
        this.retired.delete(id);
        return;
      }
      if (payload.byteLength === 0 || payload.byteLength > MAX_BROWSER_RESPONSE_BYTES) {
        throw protocolError();
      }
      this.pendingBrowser.delete(id);
      clearTimeout(pending.timer);
      if (pending.abort) pending.signal?.removeEventListener('abort', pending.abort);
      pending.resolve(payload);
      return;
    }
    if (kind === FRAME.cancel && this.options.role === 'core' && payload.byteLength === 0) {
      const active = this.active.get(id);
      if (!active) {
        if (this.retired.has(id)) return;
        throw protocolError();
      }
      active.cancelled = true;
      active.controller.abort();
      return;
    }
    if (kind === FRAME.browserCancel && this.options.role === 'core' && payload.byteLength === 0) {
      const active = this.activeBrowser.get(id);
      if (!active) {
        const retired = this.retired.get(id);
        if (retired?.kind === 'browser') return;
        throw protocolError();
      }
      active.cancelled = true;
      active.controller.abort();
      return;
    }
    throw protocolError();
  }

  private async writeAcp(chunk: Buffer): Promise<void> {
    if (!Buffer.isBuffer(chunk) || chunk.byteLength === 0) throw protocolError();
    for (let offset = 0; offset < chunk.byteLength; offset += MAX_ACP_FRAME_BYTES) {
      await this.send(FRAME.acp, 0, chunk.subarray(offset, offset + MAX_ACP_FRAME_BYTES));
    }
  }

  private send(kind: number, id: number, payload: Buffer): Promise<void> {
    if (this.closed || this.options.stream.destroyed || !this.options.stream.writable) {
      return Promise.reject(protocolError());
    }
    const frame = encodedFrame(kind, id, payload);
    return new Promise((resolve, reject) => {
      this.options.stream.write(frame, (error) => error ? reject(error) : resolve());
    });
  }

  private fail(error: Error): void {
    if (this.closed) return;
    this.closed = true;
    this.rejectAll(error);
    for (const active of this.active.values()) active.controller.abort();
    this.active.clear();
    for (const active of this.activeBrowser.values()) active.controller.abort();
    this.activeBrowser.clear();
    this.clearRetired();
    this.acpInput.destroy(error);
    this.acp.destroy(error);
    this.options.stream.destroy();
  }

  private rejectAll(error: Error): void {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      if (pending.abort) pending.signal?.removeEventListener('abort', pending.abort);
      pending.reject(error);
    }
    this.pending.clear();
    for (const pending of this.pendingBrowser.values()) {
      clearTimeout(pending.timer);
      if (pending.abort) pending.signal?.removeEventListener('abort', pending.abort);
      pending.reject(error);
    }
    this.pendingBrowser.clear();
  }

  private clearRetired(): void {
    this.retired.clear();
  }

  private retireRequest(
    id: number,
    kind: RetiredRequest['kind'],
    requestId?: string,
  ): void {
    this.retired.delete(id);
    this.retired.set(id, { kind, ...(requestId ? { requestId } : {}) });
    while (this.retired.size > MAX_RETIRED_REQUESTS) {
      const oldest = this.retired.keys().next().value as number | undefined;
      if (oldest === undefined) break;
      this.retired.delete(oldest);
    }
  }
}
