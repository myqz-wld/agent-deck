import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import * as tokens from '@main/agent-deck-mcp/mcp-session-token-map';
import { SessionRecoverer } from '@main/adapters/codex-cli/sdk-bridge/recoverer';
import type { CodexBridgeRuntimeHost } from '@main/adapters/codex-cli/sdk-bridge/runtime-host-core';
import type { AgentEvent, SessionRecord } from '@shared/types';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ServerCoreMcpBroker } from './mcp-broker';
import type { ServerCoreMcpToolHost } from './mcp-tool-host';
import { ServerCoreSessionManager, type ServerCoreSessionRepositoryPort } from './session-manager';

const brokers: ServerCoreMcpBroker[] = [];
const sessionId = 'retained-assistant';
const delivery = { initialEnqueueOptions: {
  deferUserEventUntilTurnStart: true, idempotencyKey: 'feishu:retry', turnCorrelationId: 'feishu:retry',
} };

function harness(archivedAt: number | null = null) {
  let record: SessionRecord = {
    id: sessionId, agentId: 'codex-cli', cwd: '/workspace', title: 'Assistant', source: 'sdk',
    lifecycle: 'closed', activity: 'finished', startedAt: 1, lastEventAt: 2, endedAt: 3,
    archivedAt, cliSessionId: sessionId, model: 'test-model', codexSandbox: 'workspace-write',
    codexApprovalPolicy: 'never',
  };
  const events: AgentEvent[] = [];
  const sessions = {
    get: (id: string) => id === sessionId ? record : null,
    findByCliSessionId: (id: string) => id === record.cliSessionId ? record : null,
    upsert: (value: SessionRecord) => { record = value; },
    setActivity: (_id: string, activity: SessionRecord['activity'], at: number) => {
      record = { ...record, activity, lastEventAt: at };
    },
    setLifecycle: (_id: string, lifecycle: SessionRecord['lifecycle'], at: number) => {
      record = { ...record, lifecycle, endedAt: lifecycle === 'closed' ? at : null };
    },
    setArchived: (_id: string, value: number | null) => { record = { ...record, archivedAt: value }; },
  } as ServerCoreSessionRepositoryPort;
  const manager = new ServerCoreSessionManager({
    sessions,
    events: { insert: event => { events.push(event); return events.length; } },
    observer: {
      eventPersisted: vi.fn(), tokenUsageObserved: vi.fn(), contextUsageObserved: vi.fn(),
      contextCompactionObserved: vi.fn(), sessionUpdated: vi.fn(), sessionRemoved: vi.fn(),
      sessionRenamed: vi.fn(), warning: vi.fn(),
    },
  });
  const emit = (event: AgentEvent) => manager.ingest(event);
  const runtimeHost = {
    records: sessions, sessions: manager, hasExactUserMessage: () => false,
    logger: () => ({ warn: vi.fn(), info: vi.fn(), error: vi.fn() }),
  } as unknown as CodexBridgeRuntimeHost;
  const create = vi.fn(async (_options: unknown) => ({ sessionId }));
  const recoverer = new SessionRecoverer(
    { recovering: new Map(), emit, runtimeHost }, create, vi.fn(), () => true, () => true,
    () => { throw new Error('Native history needs no continuation capture'); },
    vi.fn(), vi.fn(),
  );
  const broker = new ServerCoreMcpBroker({
    host: { sessions } as unknown as ServerCoreMcpToolHost,
    diagnostics: { info: vi.fn(), warn: vi.fn() },
  });
  brokers.push(broker);
  return { broker, create, emit, events, manager, recoverer, record: () => record };
}

afterEach(async () => {
  tokens.clearAll();
  await Promise.allSettled(brokers.splice(0).map(broker => broker.stop()));
});

describe('Feishu deferred Codex recovery', () => {
  it.each([null, 4])('authenticates native resume before accepting deferred input (archivedAt=%s)', async archivedAt => {
    const t = harness(archivedAt);
    await t.broker.start();
    t.create.mockImplementation(async () => {
      // The adapter announces the retained identity before native thread/resume initializes MCP.
      t.emit({ sessionId, agentId: 'codex-cli', kind: 'session-start', source: 'sdk',
        ts: 10, payload: { cwd: '/workspace', source: 'sdk' } });
      const transport = new StreamableHTTPClientTransport(
        new URL(`http://127.0.0.1:${t.broker.listeningPort}/mcp`),
        { requestInit: { headers: { authorization: `Bearer ${tokens.allocate(sessionId)}` } } },
      );
      const client = new Client({ name: 'deferred-recovery-test', version: '1.0.0' });
      try {
        await client.connect(transport);
        expect(t.events.some(event => (event.payload as { role?: string }).role === 'user')).toBe(false);
        expect(t.record()).toMatchObject({ id: sessionId, lifecycle: 'active', archivedAt: null,
          model: 'test-model', codexSandbox: 'workspace-write', codexApprovalPolicy: 'never' });
        t.emit({ sessionId, agentId: 'codex-cli', kind: 'message', source: 'sdk', ts: 11,
          payload: { role: 'user', text: 'hello', turnCorrelationId: 'feishu:retry' } });
        return { sessionId };
      } finally {
        await Promise.allSettled([client.close(), transport.close()]);
      }
    });

    await expect(t.recoverer.recoverAndSend(sessionId, 'hello', undefined, delivery)).resolves.toBe(sessionId);
    expect(t.create).toHaveBeenCalledWith(expect.objectContaining({ resume: sessionId,
      model: 'test-model', codexSandbox: 'workspace-write', approvalPolicy: 'never',
      initialEnqueueOptions: delivery.initialEnqueueOptions }));
    expect(t.events.filter(event => (event.payload as { role?: string }).role === 'user')).toHaveLength(1);
  });

  it('rolls back lifecycle when native resume fails without recording deferred user input', async () => {
    const t = harness();
    t.create.mockImplementation(async () => {
      expect(t.record().lifecycle).toBe('active');
      throw new Error('Native resume failed');
    });
    await expect(t.recoverer.recoverAndSend(sessionId, 'hello', undefined, delivery))
      .rejects.toThrow('Native resume failed');
    expect(t.record().lifecycle).toBe('closed');
    expect(t.events.some(event => (event.payload as { role?: string }).role === 'user')).toBe(false);
  });

  it('honors a new close while unarchiving and never reactivates or starts the provider', async () => {
    const t = harness(4);
    const unarchive = t.manager.unarchive.bind(t.manager);
    vi.spyOn(t.manager, 'unarchive').mockImplementation(async id => {
      await unarchive(id);
      await t.manager.close(id);
    });
    await expect(t.recoverer.recoverAndSend(sessionId, 'hello', undefined, delivery)).resolves.toBe(sessionId);
    expect(t.create).not.toHaveBeenCalled();
    expect(t.record().lifecycle).toBe('closed');
  });
});
