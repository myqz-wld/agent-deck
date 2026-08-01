/**
 * Per-tab CDP bridge: attach/detach, command send with timeout, event fan-out, and lazily enabled
 * console / network ring buffers.
 *
 * Two consumers with different needs share this file. The Codex pipe front needs raw command
 * pass-through plus every event, including child-target traffic. The MCP browser tools need cheap
 * console and network history. MCP tabs arm lightweight network lifecycle tracking before their
 * first navigation so `browser_wait(kind:"network-idle")` can observe the whole request. Network
 * history remains independently lazy and starts only at the first `browser_read_network` call.
 * Codex tabs never call that MCP-only arming path, so the official Browser client still owns their
 * CDP domains.
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

interface PendingNetworkRequest {
  method: string;
  url: string;
  at: number;
  status?: number;
  mimeType?: string;
  recorded: boolean;
}

export interface NetworkActivityState {
  inFlight: number;
  lastActivityAt: number;
}

export class CdpBridge {
  private readonly messageListeners = new Set<CdpMessageListener>();
  private readonly detachListeners = new Set<CdpDetachListener>();
  private readonly consoleEntries: ConsoleEntry[] = [];
  private readonly networkEntries: NetworkEntry[] = [];
  private readonly pendingRequests = new Map<string, PendingNetworkRequest>();
  private readonly inFlightRequestIds = new Set<string>();
  private listenersInstalled = false;
  private consoleEnabled = false;
  private consoleEnablePromise: Promise<void> | null = null;
  private networkDomainEnabled = false;
  private networkTrackingEnabled = false;
  private networkCaptureEnabled = false;
  private networkEnablePromise: Promise<void> | null = null;
  private lastNetworkActivityAt = 0;

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
    this.resetDomainState();
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

  enableConsoleCapture(): Promise<void> {
    if (this.consoleEnabled) return Promise.resolve();
    if (this.consoleEnablePromise != null) return this.consoleEnablePromise;

    const enabling = this.send('Runtime.enable')
      .then(() => {
        if (this.consoleEnablePromise !== enabling) return;
        return this.send('Log.enable');
      })
      .then(() => {
        if (this.consoleEnablePromise === enabling) this.consoleEnabled = true;
      })
      .catch((error) => {
        if (this.consoleEnablePromise === enabling) this.consoleEnabled = false;
        throw error;
      })
      .finally(() => {
        if (this.consoleEnablePromise === enabling) this.consoleEnablePromise = null;
      });
    this.consoleEnablePromise = enabling;
    return enabling;
  }

  async enableNetworkCapture(): Promise<void> {
    this.networkCaptureEnabled = true;
    try {
      await this.enableNetworkTracking();
    } catch (error) {
      this.networkCaptureEnabled = false;
      throw error;
    }
  }

  /**
   * Enable request lifecycle tracking without starting network-history recording.
   *
   * MCP calls this before navigation. Keeping it separate from `enableNetworkCapture` preserves
   * the documented "history starts at first read" behavior while making network-idle deterministic.
   */
  async enableNetworkTracking(): Promise<void> {
    if (this.networkDomainEnabled) {
      this.networkTrackingEnabled = true;
      return;
    }
    if (this.networkEnablePromise != null) {
      await this.networkEnablePromise;
      this.networkTrackingEnabled = true;
      return;
    }

    this.networkTrackingEnabled = true;
    this.lastNetworkActivityAt = Date.now();
    const enabling = this.send('Network.enable')
      .then(() => {
        this.networkDomainEnabled = true;
      })
      .catch((error) => {
        this.networkTrackingEnabled = false;
        throw error;
      })
      .finally(() => {
        if (this.networkEnablePromise === enabling) this.networkEnablePromise = null;
      });
    this.networkEnablePromise = enabling;
    await enabling;
  }

  networkActivityState(): NetworkActivityState {
    return {
      inFlight: this.inFlightRequestIds.size,
      lastActivityAt: this.lastNetworkActivityAt,
    };
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
      this.resetDomainState();
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
      if (!this.networkTrackingEnabled) return;
      const request = asRecord(params.request);
      const requestId = asString(params.requestId);
      if (requestId == null) return;
      const at = this.noteNetworkActivity();
      this.inFlightRequestIds.add(requestId);
      if (this.networkCaptureEnabled) {
        this.recordRedirectIfPresent(requestId, params);
        this.pendingRequests.set(requestId, {
          method: asString(request.method) ?? 'GET',
          url: asString(request.url) ?? '',
          at,
          recorded: false,
        });
      } else {
        // A request that began before history capture was enabled must not appear retroactively.
        this.pendingRequests.delete(requestId);
      }
      return;
    }
    if (method === 'Network.responseReceived') {
      if (!this.networkTrackingEnabled) return;
      this.noteNetworkActivity();
      const response = asRecord(params.response);
      const pending = this.getPending(asString(params.requestId));
      if (pending == null) return;
      pending.status = typeof response.status === 'number' ? response.status : undefined;
      pending.mimeType = asString(response.mimeType);
      return;
    }
    if (method === 'Network.loadingFinished') {
      if (!this.networkTrackingEnabled) return;
      const pending = this.finishRequest(asString(params.requestId));
      if (pending != null && !pending.recorded) {
        this.pushNetwork(this.toNetworkEntry(pending));
      }
      return;
    }
    if (method === 'Network.loadingFailed') {
      if (!this.networkTrackingEnabled) return;
      const requestId = asString(params.requestId);
      const pending = this.finishRequest(requestId);
      if (pending == null) return;
      this.pushNetwork({
        ...this.toNetworkEntry(pending),
        failure: asString(params.errorText) ?? 'loading failed',
      });
    }
  }

  private getPending(requestId: string | undefined): PendingNetworkRequest | null {
    if (requestId == null) return null;
    return this.pendingRequests.get(requestId) ?? null;
  }

  private finishRequest(requestId: string | undefined): PendingNetworkRequest | null {
    this.noteNetworkActivity();
    if (requestId == null) return null;
    this.inFlightRequestIds.delete(requestId);
    const pending = this.pendingRequests.get(requestId) ?? null;
    this.pendingRequests.delete(requestId);
    return pending;
  }

  private recordRedirectIfPresent(requestId: string, params: UnknownRecord): void {
    const previous = this.pendingRequests.get(requestId);
    if (previous == null || previous.recorded) return;
    const redirect = asRecord(params.redirectResponse);
    if (Object.keys(redirect).length === 0) return;
    previous.status = typeof redirect.status === 'number' ? redirect.status : undefined;
    previous.mimeType = asString(redirect.mimeType);
    this.pushNetwork(this.toNetworkEntry(previous));
    previous.recorded = true;
  }

  private toNetworkEntry(pending: PendingNetworkRequest): NetworkEntry {
    return {
      at: pending.at,
      method: pending.method,
      url: pending.url,
      status: pending.status,
      mimeType: pending.mimeType,
    };
  }

  private noteNetworkActivity(): number {
    const at = Date.now();
    this.lastNetworkActivityAt = at;
    return at;
  }

  private resetDomainState(): void {
    this.consoleEnabled = false;
    this.consoleEnablePromise = null;
    this.networkDomainEnabled = false;
    this.networkTrackingEnabled = false;
    this.networkCaptureEnabled = false;
    this.networkEnablePromise = null;
    this.lastNetworkActivityAt = 0;
    this.inFlightRequestIds.clear();
    this.pendingRequests.clear();
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
