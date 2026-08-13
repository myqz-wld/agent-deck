import {
  AgentDeckCapability,
  parseDesktopBrokerNextResult,
  parseDesktopBrokerRespondResult,
  parseDesktopBrokerToolResult,
  type DesktopBrokerRequestDto,
  type DesktopBrokerToolResult,
  type JsonValue,
} from '@contracts/index';
import type {
  ElectronHostEvent,
  ElectronHostRegistry,
  ElectronHostState,
} from '@hosts/electron';
import { disposeSessionBrowser } from '@main/browser-use/session-browser';

import {
  executeRemoteBrowserRequest,
  remoteBrowserOwnerId,
} from './remote-browser-executor';
import { parseRemoteSessionRename } from './remote-session-rename';

const POLL_WAIT_MS = 20_000;
const POLL_DEADLINE_MS = 25_000;
const RESPONSE_DEADLINE_MS = 10_000;
const RETRY_DELAY_MS = 750;
const STOP_JOIN_MS = 2_000;

interface ProfileLoop {
  readonly profileId: string;
  readonly identity: string;
  readonly coreId: string;
  readonly generation: number | null;
  readonly controller: AbortController;
  readonly owners: Map<string, string>;
  task: Promise<void>;
}

export interface RemoteHostDesktopBrokerPort {
  handleState(state: ElectronHostState): void;
  handleEvent(event: ElectronHostEvent): void;
  stop(): Promise<void>;
}

export interface RemoteHostDesktopBrowserBrokerOptions {
  readonly registry: ElectronHostRegistry;
  readonly execute?: typeof executeRemoteBrowserRequest;
}

function identity(state: ElectronHostState): string | null {
  if (!state.authoritativeCoreId) return null;
  return `${state.authoritativeCoreId.length}:${state.authoritativeCoreId}|${state.workerGeneration ?? ''}`;
}

function delay(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(done, ms);
    timer.unref?.();
    function done(): void {
      signal.removeEventListener('abort', done);
      clearTimeout(timer);
      resolve();
    }
    signal.addEventListener('abort', done, { once: true });
  });
}

function lifecycle(payload: JsonValue): string | null {
  return payload && typeof payload === 'object' && !Array.isArray(payload) &&
    typeof payload.lifecycle === 'string'
    ? payload.lifecycle
    : null;
}

/** Desktop-owned long-poll worker for Core MCP browser requests. */
export class RemoteHostDesktopBrowserBroker implements RemoteHostDesktopBrokerPort {
  private readonly loops = new Map<string, ProfileLoop>();
  private readonly execute: typeof executeRemoteBrowserRequest;
  private stopped = false;

  constructor(private readonly options: RemoteHostDesktopBrowserBrokerOptions) {
    this.execute = options.execute ?? executeRemoteBrowserRequest;
  }

  handleState(state: ElectronHostState): void {
    if (this.stopped) return;
    const nextIdentity = identity(state);
    const usable = state.status === 'connected' && nextIdentity !== null &&
      state.capabilities.includes(AgentDeckCapability.Browser);
    const existing = this.loops.get(state.profileId);
    if (!usable) {
      if (existing) void this.retire(existing);
      return;
    }
    if (existing?.identity === nextIdentity) return;
    if (existing) void this.retire(existing);
    const loop: ProfileLoop = {
      profileId: state.profileId,
      identity: nextIdentity,
      coreId: state.authoritativeCoreId!,
      generation: state.workerGeneration,
      controller: new AbortController(),
      owners: new Map(),
      task: Promise.resolve(),
    };
    this.loops.set(state.profileId, loop);
    loop.task = this.run(loop);
  }

  handleEvent(event: ElectronHostEvent): void {
    const loop = this.loops.get(event.profileId);
    if (!loop) return;
    if (event.kind === 'session.removed' && event.entityId) {
      void this.disposeSession(loop, event.entityId);
      return;
    }
    if (event.kind === 'session.updated' && event.entityId && lifecycle(event.payload) === 'closed') {
      void this.disposeSession(loop, event.entityId);
      return;
    }
    if (event.kind === 'session.renamed') {
      const value = parseRemoteSessionRename(event.payload);
      if (!value) return;
      const owner = loop.owners.get(value.fromId);
      if (owner) {
        loop.owners.delete(value.fromId);
        loop.owners.set(value.toId, owner);
      }
    }
  }

  async stop(): Promise<void> {
    if (this.stopped) return;
    this.stopped = true;
    const loops = [...this.loops.values()];
    this.loops.clear();
    for (const loop of loops) loop.controller.abort();
    await Promise.allSettled(loops.flatMap((loop) =>
      [...loop.owners.values()].map((owner) => disposeSessionBrowser(owner))));
    await Promise.race([
      Promise.allSettled(loops.map((loop) => loop.task)),
      delay(STOP_JOIN_MS, new AbortController().signal),
    ]);
  }

  private async run(loop: ProfileLoop): Promise<void> {
    while (!loop.controller.signal.aborted && !this.stopped) {
      try {
        const client = this.options.registry.getClient(loop.profileId);
        if (!client || !this.current(loop, client)) return;
        const next = parseDesktopBrokerNextResult(await client.request(
          'desktop.broker.next',
          { waitMs: POLL_WAIT_MS },
          { deadlineMs: POLL_DEADLINE_MS, signal: loop.controller.signal },
        ));
        if (!next.request) continue;
        if (!this.current(loop, client)) return;
        const result = await this.executeWithinLease(loop, next.request);
        if (!this.current(loop, client)) return;
        parseDesktopBrokerRespondResult(await client.request(
          'desktop.broker.respond',
          { requestId: next.request.requestId, result },
          { deadlineMs: RESPONSE_DEADLINE_MS, signal: loop.controller.signal },
        ));
      } catch {
        if (loop.controller.signal.aborted || this.stopped) return;
        await delay(RETRY_DELAY_MS, loop.controller.signal);
      }
    }
  }

  private current(
    loop: ProfileLoop,
    client: ReturnType<ElectronHostRegistry['getClient']>,
  ): boolean {
    if (this.loops.get(loop.profileId) !== loop) return false;
    if (this.options.registry.getClient(loop.profileId) !== client) return false;
    const state = this.options.registry.state(loop.profileId);
    return state.status === 'connected' && identity(state) === loop.identity &&
      state.capabilities.includes(AgentDeckCapability.Browser);
  }

  private owner(loop: ProfileLoop, request: DesktopBrokerRequestDto): string {
    const existing = loop.owners.get(request.sessionId);
    if (existing) return existing;
    const owner = remoteBrowserOwnerId({
      profileId: loop.profileId,
      coreId: loop.coreId,
      generation: loop.generation,
      sessionId: request.sessionId,
    });
    loop.owners.set(request.sessionId, owner);
    return owner;
  }

  private expiredResult(): DesktopBrokerToolResult {
    return parseDesktopBrokerToolResult({
      content: [{
        type: 'text',
        text: JSON.stringify({
          error: 'Browser request expired before desktop execution',
          hint: 'Retry while the desktop connection is active.',
        }),
      }],
      isError: true,
    });
  }

  private async executeWithinLease(
    loop: ProfileLoop,
    request: DesktopBrokerRequestDto,
  ): Promise<DesktopBrokerToolResult> {
    const owner = this.owner(loop, request);
    let timer: ReturnType<typeof setTimeout> | null = null;
    const expired = new Promise<DesktopBrokerToolResult>((resolve) => {
      timer = setTimeout(() => {
        void disposeSessionBrowser(owner);
        resolve(this.expiredResult());
      }, request.leaseMs);
      timer.unref?.();
    });
    try {
      return await Promise.race([this.execute(owner, request), expired]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  private async retire(loop: ProfileLoop): Promise<void> {
    if (this.loops.get(loop.profileId) === loop) this.loops.delete(loop.profileId);
    loop.controller.abort();
    await Promise.allSettled(
      [...loop.owners.values()].map((owner) => disposeSessionBrowser(owner)),
    );
  }

  private async disposeSession(loop: ProfileLoop, sessionId: string): Promise<void> {
    const owner = loop.owners.get(sessionId);
    if (!owner) return;
    loop.owners.delete(sessionId);
    await disposeSessionBrowser(owner);
  }
}
