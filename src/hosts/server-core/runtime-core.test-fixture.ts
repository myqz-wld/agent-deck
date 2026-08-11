import { vi } from 'vitest';
import type {
  AuthenticatedClientAccessContext,
  CoreMethod,
  JsonObject,
  JsonValue,
  PendingRequestDto,
  SessionConsoleAttachmentInput,
} from '@contracts/index';
import type { DaemonRequestInput } from '@hosts/daemon';
import type { AgentAdapter } from '@main/adapters/types';
import type { SessionRecord, StoredAgentEvent, UploadedAttachmentRef } from '@shared/types';

import {
  ServerCoreDaemonRuntime,
  type ServerCoreRuntimeMetadataPort,
} from './runtime-core';
import type {
  ServerCoreChangeRecord,
  ServerCoreMutationClaim,
  ServerCoreMutationIdentity,
} from './runtime-metadata-store';
import type { ServerCoreMcpHandOffPort } from './mcp-handoff-port';

export const runtimeCoreAccess: AuthenticatedClientAccessContext = {
  kind: 'authenticated-client',
  topology: 'server-core',
  instanceId: 'instance-a',
  clientId: 'client-a',
  transport: 'ssh',
  accessCredentialId: 'credential-a',
  authority: 'owner-equivalent',
  surface: 'desktop-full',
};

export function runtimeCoreRecord(overrides: Partial<SessionRecord> = {}): SessionRecord {
  return {
    id: 'session-a',
    agentId: 'claude-code',
    cwd: '/workspaces/private',
    title: 'Private session',
    source: 'sdk',
    lifecycle: 'active',
    activity: 'idle',
    startedAt: 10,
    lastEventAt: 20,
    endedAt: null,
    archivedAt: null,
    ...overrides,
  };
}

export class FakeRuntimeCoreMetadata implements ServerCoreRuntimeMetadataPort {
  revision = 0;
  firstRetained = 1;
  readonly changes: ServerCoreChangeRecord[] = [];
  readonly listeners = new Set<(change: ServerCoreChangeRecord) => void>();
  readonly ledger = new Map<string, {
    identity: ServerCoreMutationIdentity;
    result?: JsonValue;
    revision?: number;
  }>();
  readonly subscriptions = new Map<string, boolean>();

  currentRevision(): number { return this.revision; }

  appendChange(kind: string, entityId: string | null, payload: JsonValue): number {
    const change = { revision: ++this.revision, kind, entityId, payload };
    this.changes.push(change);
    for (const listener of [...this.listeners]) listener(change);
    return change.revision;
  }

  replay(afterRevision: number): ServerCoreChangeRecord[] {
    if (afterRevision < this.firstRetained - 1) throw new Error('gap');
    return this.changes.filter((change) => change.revision > afterRevision);
  }

  subscribe(listener: (change: ServerCoreChangeRecord) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  claimMutation(
    identity: ServerCoreMutationIdentity,
    _now?: number,
    expectedRevision?: number,
  ): ServerCoreMutationClaim {
    const key = `${identity.accessCredentialId}\u0000${identity.accessSurface}\u0000${identity.idempotencyKey}`;
    const current = this.ledger.get(key);
    if (current) {
      if (
        current.identity.method !== identity.method ||
        current.identity.requestFingerprint !== identity.requestFingerprint
      ) return { state: 'conflict' };
      if (current.result === undefined || current.revision === undefined) {
        return { state: 'uncertain' };
      }
      return { state: 'completed', result: current.result, revision: current.revision };
    }
    if (expectedRevision !== undefined && expectedRevision !== this.revision) {
      return { state: 'conflict' };
    }
    this.ledger.set(key, { identity });
    return { state: 'claimed' };
  }

  completeMutation(
    identity: ServerCoreMutationIdentity,
    result: JsonValue,
    revision: number,
  ): void {
    const key = `${identity.accessCredentialId}\u0000${identity.accessSurface}\u0000${identity.idempotencyKey}`;
    const row = this.ledger.get(key);
    if (!row) throw new Error('claim missing');
    row.result = result;
    row.revision = revision;
  }

  setSubscribed(
    credential: string,
    surface: 'desktop-full' | 'feishu-session-console',
    sessionId: string,
    subscribed: boolean,
  ): void {
    this.subscriptions.set(`${credential}:${surface}:${sessionId}`, subscribed);
  }
}

export function runtimeCoreHarness(options: {
  adapter?: Partial<AgentAdapter>;
  session?: SessionRecord;
  events?: StoredAgentEvent[];
  presentations?: {
    list(sessionId: string): PendingRequestDto[];
    respond(sessionId: string, requestId: string, action: string, value?: JsonValue):
      'denied' | 'resolved' | null;
  };
  attachmentStore?: {
    persist(inputs: readonly SessionConsoleAttachmentInput[]): Promise<UploadedAttachmentRef[]>;
    remove(refs: readonly UploadedAttachmentRef[]): Promise<void>;
  };
  handoff?: ServerCoreMcpHandOffPort;
} = {}) {
  const sessions = new Map<string, SessionRecord>();
  const session = options.session ?? runtimeCoreRecord();
  sessions.set(session.id, session);
  const sendMessage = vi.fn(async () => undefined);
  const adapter = {
    id: session.agentId,
    displayName: session.agentId,
    capabilities: {},
    init: vi.fn(async () => undefined),
    shutdown: vi.fn(async () => undefined),
    sendMessage,
    ...options.adapter,
  } as unknown as AgentAdapter;
  const metadata = new FakeRuntimeCoreMetadata();
  const events = options.events ?? [];
  const start = vi.fn(async () => undefined);
  const stop = vi.fn(async () => undefined);
  const runtime = new ServerCoreDaemonRuntime({
    instanceId: 'instance-a',
    repository: { get: (id) => sessions.get(id) ?? null },
    events: {
      listValidForSession: (_id, limit, offset) => events.slice(offset, offset + limit),
      countForSession: () => events.length,
    },
    registry: { get: (id) => id === adapter.id ? adapter : undefined },
    metadata,
    lifecycle: { start, stop },
    presentations: options.presentations ?? { list: () => [], respond: () => null },
    ...(options.attachmentStore ? { attachmentStore: options.attachmentStore } : {}),
    ...(options.handoff ? { handoff: options.handoff } : {}),
  });
  return { adapter, metadata, runtime, sendMessage, sessions, start, stop };
}

export function runtimeCoreInput(
  method: CoreMethod,
  params: JsonObject,
  options: { idempotencyKey?: string | null; expectedRevision?: number | null } = {},
): DaemonRequestInput {
  return {
    access: runtimeCoreAccess,
    requestId: `request-${method}`,
    method,
    params,
    idempotencyKey: options.idempotencyKey ?? null,
    expectedRevision: options.expectedRevision ?? null,
    deadlineAt: null,
    signal: new AbortController().signal,
  };
}
