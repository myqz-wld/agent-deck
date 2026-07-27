/**
 * Per-tab CDP bridge: attach/detach, command send with timeout, event fan-out, and lazily enabled
 * console / network ring buffers.
 *
 * Two consumers with different needs share this file. The Codex pipe front needs raw command
 * pass-through plus every event, including child-target traffic. The MCP browser tools need cheap
 * console and network history. Domain enabling is therefore lazy: a Codex session that never asks
 * for logs keeps exactly the CDP surface the official Browser client enabled itself.
 */

import type { Debugger, Event } from 'electron';

import { CDP_TIMEOUT_MS, type CdpDetachListener, type CdpMessageListener } from './types';

const MAX_CONSOLE_ENTRIES = 200;
const MAX_NETWORK_ENTRIES = 200;

export interface ConsoleEntry {
  at: number;
  level: string;
  text: string;
  source?: string;
}

export interface NetworkEntry {
  at: number;
  method: string;
  url: string;
  status?: number;
  mimeType?: string;
  failure?: string;
}

type UnknownRecord = Record<string, unknown>;

export class CdpBridge {
  private readonly messageListeners = new Set<CdpMessageListener>();
  private readonly detachListeners = new Set<CdpDetachListener>();
  private readonly consoleEntries: ConsoleEntry[] = [];
  private readonly networkEntries: NetworkEntry[] = [];
  private readonly pendingRequests = new Map<string, { method: string; url: string; at: number }>();
  private listenersInstalled = false;
  private consoleEnabled = false;
  private networkEnabled = false;

  constructor(private readonly getDebugger: () => Debugger) {}

  attach(): void {
    const target = this.getDebugger();
    if (!target.isAttached()) {
      try {
        target.attach('1.3');
      } catch (error) {
        // A second attach for the same webContents is benign; anything else is a real failure.
        if (!String(error).includes('already attached')) throw error;
      }
    }
    this.installListeners();
  }

  detach(): void {
    const target = this.getDebugger();
    if (target.isAttached()) target.detach();
    this.consoleEnabled = false;
    this.networkEnabled = false;
  }

  isAttached(): boolean {
    return this.getDebugger().isAttached();
  }

  async send(
    method: string,
    params: UnknownRecord = {},
    cdpSessionId?: string,
    timeoutMs = CDP_TIMEOUT_MS,
  ): Promise<unknown> {
    this.attach();
    const command = this.getDebugger().sendCommand(method, params, cdpSessionId);
    return withTimeout(command, timeoutMs, `CDP command timed out: ${method}`);
  }

  onMessage(listener: CdpMessageListener): () => void {
    this.messageListeners.add(listener);
    return () => this.messageListeners.delete(listener);
  }

  onDetach(listener: CdpDetachListener): () => void {
    this.detachListeners.add(listener);
    return () => this.detachListeners.delete(listener);
  }

  async enableConsoleCapture(): Promise<void> {
    if (this.consoleEnabled) return;
    this.consoleEnabled = true;
    await this.send('Runtime.enable');
    await this.send('Log.enable');
  }

  async enableNetworkCapture(): Promise<void> {
    if (this.networkEnabled) return;
    this.networkEnabled = true;
    await this.send('Network.enable');
  }

  readConsole(limit: number): ConsoleEntry[] {
    return this.consoleEntries.slice(-limit);
  }

  readNetwork(limit: number): NetworkEntry[] {
    return this.networkEntries.slice(-limit);
  }

  clearBuffers(): void {
    this.consoleEntries.length = 0;
    this.networkEntries.length = 0;
    this.pendingRequests.clear();
  }

  private installListeners(): void {
    if (this.listenersInstalled) return;
    this.listenersInstalled = true;
    const target = this.getDebugger();
    target.on(
      'message',
      (_event: Event, method: string, params: UnknownRecord, debuggerSessionId?: string) => {
        // Electron reports top-level page events with an empty-string session id. Forwarding that
        // value makes the official Browser client treat page traffic as child-target traffic and
        // drop `Fetch.requestPaused`, which deadlocks navigation (REVIEW_177).
        const cdpSessionId = debuggerSessionId || undefined;
        this.captureLogEvent(method, params);
        for (const listener of this.messageListeners) listener(method, params, cdpSessionId);
      },
    );
    target.on('detach', (_event: Event, reason: string) => {
      this.consoleEnabled = false;
      this.networkEnabled = false;
      for (const listener of this.detachListeners) listener(reason);
    });
  }

  private captureLogEvent(method: string, params: UnknownRecord): void {
    if (method === 'Runtime.consoleAPICalled') {
      this.pushConsole({
        at: Date.now(),
        level: asString(params.type) ?? 'log',
        text: describeRemoteObjects(params.args),
      });
      return;
    }
    if (method === 'Runtime.exceptionThrown') {
      const details = asRecord(params.exceptionDetails);
      this.pushConsole({
        at: Date.now(),
        level: 'error',
        text: asString(details.text) ?? 'Uncaught exception',
        source: asString(asRecord(details.exception).description),
      });
      return;
    }
    if (method === 'Log.entryAdded') {
      const entry = asRecord(params.entry);
      this.pushConsole({
        at: Date.now(),
        level: asString(entry.level) ?? 'log',
        text: asString(entry.text) ?? '',
        source: asString(entry.url),
      });
      return;
    }
    if (method === 'Network.requestWillBeSent') {
      const request = asRecord(params.request);
      const requestId = asString(params.requestId);
      if (requestId == null) return;
      this.pendingRequests.set(requestId, {
        method: asString(request.method) ?? 'GET',
        url: asString(request.url) ?? '',
        at: Date.now(),
      });
      return;
    }
    if (method === 'Network.responseReceived') {
      const response = asRecord(params.response);
      const pending = this.takePending(asString(params.requestId));
      if (pending == null) return;
      this.pushNetwork({
        ...pending,
        status: typeof response.status === 'number' ? response.status : undefined,
        mimeType: asString(response.mimeType),
      });
      return;
    }
    if (method === 'Network.loadingFailed') {
      const pending = this.takePending(asString(params.requestId));
      if (pending == null) return;
      this.pushNetwork({
        ...pending,
        failure: asString(params.errorText) ?? 'loading failed',
      });
    }
  }

  private takePending(requestId: string | undefined): NetworkEntry | null {
    if (requestId == null) return null;
    const pending = this.pendingRequests.get(requestId);
    if (pending == null) return null;
    this.pendingRequests.delete(requestId);
    return { at: pending.at, method: pending.method, url: pending.url };
  }

  private pushConsole(entry: ConsoleEntry): void {
    this.consoleEntries.push(entry);
    if (this.consoleEntries.length > MAX_CONSOLE_ENTRIES) this.consoleEntries.shift();
  }

  private pushNetwork(entry: NetworkEntry): void {
    this.networkEntries.push(entry);
    if (this.networkEntries.length > MAX_NETWORK_ENTRIES) this.networkEntries.shift();
  }
}

function describeRemoteObjects(value: unknown): string {
  if (!Array.isArray(value)) return '';
  return value
    .map((item) => {
      const object = asRecord(item);
      if ('value' in object) return stringifyValue(object.value);
      return asString(object.description) ?? asString(object.type) ?? '';
    })
    .join(' ')
    .trim();
}

function stringifyValue(value: unknown): string {
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return String(value);
  }
}

function asRecord(value: unknown): UnknownRecord {
  return value != null && typeof value === 'object' && !Array.isArray(value)
    ? (value as UnknownRecord)
    : {};
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

export async function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  message: string,
): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(message)), Math.min(timeoutMs, CDP_TIMEOUT_MS));
      }),
    ]);
  } finally {
    if (timer != null) clearTimeout(timer);
  }
}
