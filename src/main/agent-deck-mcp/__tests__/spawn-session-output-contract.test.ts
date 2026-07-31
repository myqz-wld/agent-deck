import { beforeEach, describe, expect, it, vi } from 'vitest';
import { makeSdkLoaderMock } from '@main/__tests__/_shared/mocks/sdk-loader';
import type { CreateSessionOptions } from '@main/adapters/types';
import type { SessionRecord } from '@shared/types';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

import { getAgentDeckMcpServerForSession } from '../server';
import {
  buildAgentDeckMcpServerForExternalTransport,
} from '../transport-http';
import { err } from '../tools/helpers';
import {
  SPAWN_SESSION_AGENT_NAME_MAX_LENGTH,
  SPAWN_SESSION_EXPLICIT_DISPLAY_NAME_MAX_LENGTH,
  SPAWN_SESSION_OUTPUT_SCHEMA,
  SPAWN_SESSION_RESULT_DISPLAY_NAME_MAX_LENGTH,
  SPAWN_SESSION_SCHEMA,
} from '../tools/schemas/spawn';

const state = vi.hoisted(() => ({
  longAgentSelector: `${'p'.repeat(128)}:${'a'.repeat(128)}`,
  sessions: new Map<string, SessionRecord>(),
  messages: new Map<
    string,
    { id: string; status: 'pending' | 'delivered' | 'cancelled'; deliveredAt: number | null }
  >(),
  createCalls: [] as CreateSessionOptions[],
  teamMutations: [] as string[],
  nextChild: 1,
}));

vi.mock('@main/adapters/claude-code/sdk-loader', () => makeSdkLoaderMock());
vi.mock('@main/store/session-repo', () => ({
  sessionRepo: {
    get: (sessionId: string) => state.sessions.get(sessionId) ?? null,
    setSpawnLink: (sessionId: string, parentSessionId: string | null, spawnDepth: number) => {
      const record = state.sessions.get(sessionId);
      if (record) {
        state.sessions.set(sessionId, {
          ...record,
          spawnedBy: parentSessionId,
          spawnDepth,
        });
      }
    },
    setTitle: (sessionId: string, title: string) => {
      const record = state.sessions.get(sessionId);
      if (record) state.sessions.set(sessionId, { ...record, title });
    },
  },
}));
vi.mock('@main/session/manager', () => ({
  sessionManager: {
    recordCreatedPermissionMode: vi.fn(),
    notifyTeamMembershipChanged: vi.fn(),
    close: async (sessionId: string) => {
      const record = state.sessions.get(sessionId);
      if (record) {
        state.sessions.set(sessionId, { ...record, lifecycle: 'closed' });
      }
    },
  },
}));
vi.mock('@main/adapters/registry', () => ({
  adapterRegistry: {
    get: (adapterId: string) => {
      if (adapterId !== 'codex-cli') return undefined;
      return {
        id: adapterId,
        capabilities: { canCreateSession: true, canForkSession: true, canSetPermissionMode: false },
        createSession: async (target: CreateSessionOptions) => {
          state.createCalls.push({ ...target } as CreateSessionOptions);
          const sessionId = `target-${state.nextChild++}`;
          const registration = target.initialSessionRegistration;
          state.sessions.set(sessionId, {
            id: sessionId,
            agentId: target.agentId,
            cwd: target.cwd,
            title: 'target',
            source: 'sdk',
            lifecycle: 'active',
            activity: 'working',
            startedAt: 2,
            lastEventAt: 2,
            endedAt: null,
            archivedAt: null,
            cliSessionId: `native-${sessionId}`,
            spawnedBy: registration?.spawnLink.parentSessionId ?? null,
            spawnDepth: registration?.spawnLink.depth ?? 0,
          });
          registration?.onRegistered(sessionId);
          return sessionId;
        },
        closeSessionForRollback: async () => {},
      };
    },
  },
}));
vi.mock('@main/store/agent-deck-team-repo', () => ({
  TeamInvariantError: class TeamInvariantError extends Error {},
  agentDeckTeamRepo: {
    getByActiveName: vi.fn(() => null),
    ensureByName: (name: string) => {
      state.teamMutations.push(`ensure:${name}`);
      return { id: `team-${name}`, name };
    },
    listAllMembers: vi.fn(() => []),
    findActiveMembershipIn: vi.fn(() => null),
    addMember: (input: {
      teamId: string;
      sessionId: string;
      role: 'lead' | 'teammate';
      displayName: string | null;
    }) => {
      state.teamMutations.push(`add:${input.sessionId}`);
      return { ...input, joinedAt: 1, leftAt: null };
    },
    leaveTeam: vi.fn(() => null),
    hardDelete: vi.fn(() => true),
  },
}));
vi.mock('@main/store/agent-deck-message-repo', () => ({
  agentDeckMessageRepo: {
    insert: (input: { id: string }) => {
      const message = {
        id: input.id,
        status: 'pending' as const,
        deliveredAt: null,
      };
      state.messages.set(input.id, message);
      return message;
    },
    get: (messageId: string) => state.messages.get(messageId) ?? null,
    markDelivered: (messageId: string, deliveredAt: number) => {
      const message = state.messages.get(messageId);
      if (!message) return null;
      const delivered = { ...message, status: 'delivered' as const, deliveredAt };
      state.messages.set(messageId, delivered);
      return delivered;
    },
    cancel: (messageId: string) => {
      const message = state.messages.get(messageId);
      if (!message) return null;
      const cancelled = { ...message, status: 'cancelled' as const };
      state.messages.set(messageId, cancelled);
      return cancelled;
    },
    batchHardDelete: (messageIds: readonly string[]) => {
      const removed: string[] = [];
      for (const messageId of messageIds) {
        if (state.messages.delete(messageId)) removed.push(messageId);
      }
      return removed;
    },
  },
}));
vi.mock('../spawn-guards', () => ({
  applySpawnGuards: () => {
    let released = false;
    return {
      ok: true,
      parentDepth: 0,
      spawnLimits: {
        depth: { current: 0, next: 1, max: 3 },
        fanOut: { current: 1, activeChildren: 0, inFlight: 1, max: 10 },
        rate: { current: 1, max: 20, windowMs: 60_000, retryAfterMs: 0 },
      },
      fanOutSlot: {
        release: () => {
          if (released) return;
          released = true;
        },
      },
    };
  },
}));
vi.mock('../tools/handlers/spawn-limits', () => ({
  finalizeSpawnLimits: (limits: unknown) => limits,
}));
vi.mock('../tools/handlers/spawn-agent-resolver', () => ({
  resolveSpawnAgent: (agentName: string, adapter: string) =>
    agentName === state.longAgentSelector && adapter === 'codex-cli'
      ? {
          ok: true as const,
          developerInstructions: 'resolved long-selector agent',
        }
      : {
          ok: false as const,
          error: 'agent not found',
          hint: 'use the test agent selector',
        },
}));
vi.mock('@main/event-bus', () => ({
  eventBus: {
    emit: vi.fn(),
    on: vi.fn(),
    off: vi.fn(),
  },
}));
vi.mock('@main/utils/logger', () => ({
  default: {
    scope: () => ({
      warn: vi.fn(),
      info: vi.fn(),
      error: vi.fn(),
    }),
  },
}));

const mcpServerModule = { McpServer };

async function withClient<T>(
  server: McpServer,
  run: (client: Client) => Promise<T>,
): Promise<T> {
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  const client = new Client({
    name: 'spawn-session-output-contract-test',
    version: '1.0.0',
  });
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  try {
    return await run(client);
  } finally {
    await Promise.allSettled([client.close(), server.close()]);
  }
}

const surfaces = [
  [
    'in-process',
    async () =>
      (
        await getAgentDeckMcpServerForSession(
          () => 'caller-session',
          'codex-cli',
          mcpServerModule,
        )
      ).instance,
  ],
  [
    'http',
    () =>
      buildAgentDeckMcpServerForExternalTransport(
        'http',
        'codex-cli',
        mcpServerModule,
      ),
  ],
] as const;

function seedCaller(): void {
  state.sessions.set('caller-session', {
    id: 'caller-session',
    agentId: 'codex-cli',
    cwd: process.cwd(),
    title: 'lead',
    source: 'sdk',
    lifecycle: 'active',
    activity: 'working',
    startedAt: 1,
    lastEventAt: 1,
    endedAt: null,
    archivedAt: null,
    cliSessionId: 'native-caller',
    spawnedBy: null,
    spawnDepth: 0,
  });
}

function firstText(result: unknown): string {
  if (typeof result !== 'object' || result === null || !('content' in result)) {
    throw new Error('expected MCP tool result with content');
  }
  const content = (result as { content: unknown }).content;
  if (!Array.isArray(content)) throw new Error('expected MCP content array');
  const first = content[0] as { type?: unknown; text?: unknown } | undefined;
  if (first?.type !== 'text' || typeof first.text !== 'string') {
    throw new Error('expected MCP text result');
  }
  return first.text;
}

function firstTextPayload(result: unknown): Record<string, unknown> {
  const text = firstText(result);
  try {
    return JSON.parse(text) as Record<string, unknown>;
  } catch {
    throw new Error(`expected JSON MCP text result, received: ${text}`);
  }
}

beforeEach(() => {
  state.sessions.clear();
  state.messages.clear();
  state.createCalls.length = 0;
  state.teamMutations.length = 0;
  state.nextChild = 1;
  seedCaller();
});

describe('spawn_session public output contract', () => {
  it.each(surfaces)(
    'publishes one machine-readable success schema through %s tools/list',
    async (_surface, buildServer) => {
      const server = await buildServer();
      await withClient(server, async (client) => {
        const listed = await client.listTools();
        const spawn = listed.tools.find((tool) => tool.name === 'spawn_session');

        expect(spawn?.outputSchema).toMatchObject({ type: 'object' });
        expect(spawn?.outputSchema?.required).toEqual(
          expect.arrayContaining([
            'sessionId',
            'adapter',
            'gateway',
            'profile',
            'cwd',
            'teamId',
            'teamName',
            'agentName',
            'displayName',
            'spawnDepth',
            'spawnLimits',
            'sentAt',
            'spawnPromptMessageId',
          ]),
        );
        expect(spawn?.inputSchema.properties).not.toHaveProperty(
          'parentSessionId',
        );
      });
    },
  );

  it('does not expose caller-controlled parent lineage', () => {
    expect(SPAWN_SESSION_SCHEMA).not.toHaveProperty('parentSessionId');
    expect(state.longAgentSelector).toHaveLength(
      SPAWN_SESSION_AGENT_NAME_MAX_LENGTH,
    );
    expect(SPAWN_SESSION_EXPLICIT_DISPLAY_NAME_MAX_LENGTH).toBe(80);
    expect(SPAWN_SESSION_RESULT_DISPLAY_NAME_MAX_LENGTH).toBe(
      SPAWN_SESSION_AGENT_NAME_MAX_LENGTH,
    );
  });

  it('returns a schema-valid long agent fallback through the registered production handler', async () => {
    const server = (
      await getAgentDeckMcpServerForSession(
        () => 'caller-session',
        'codex-cli',
        mcpServerModule,
      )
    ).instance;

    await withClient(server, async (client) => {
      const listed = await client.listTools();
      const spawn = listed.tools.find((tool) => tool.name === 'spawn_session');
      expect(spawn?.outputSchema).toBeDefined();

      const result = await client.callTool({
        name: 'spawn_session',
        arguments: {
          adapter: 'codex-cli',
          cwd: process.cwd(),
          prompt: 'bounded production-handler contract task',
          agentName: state.longAgentSelector,
        },
      });
      expect(result.isError).not.toBe(true);
      expect(result.content).toEqual([]);
      expect(
        SPAWN_SESSION_OUTPUT_SCHEMA.safeParse(result.structuredContent).success,
      ).toBe(true);
      const payload = result.structuredContent as Record<string, unknown>;
      expect(payload.displayName).toBe(state.longAgentSelector);
      expect(payload.agentName).toBe(state.longAgentSelector);
      expect(state.createCalls).toHaveLength(1);
    });
  });

  it('rejects requested-team spawn from a caller with no durable row before side effects', async () => {
    state.sessions.clear();
    const server = (
      await getAgentDeckMcpServerForSession(
        () => 'missing-caller',
        'codex-cli',
        mcpServerModule,
      )
    ).instance;

    await withClient(server, async (client) => {
      const result = await client.callTool({
        name: 'spawn_session',
        arguments: {
          adapter: 'codex-cli',
          cwd: process.cwd(),
          prompt: 'must not create a target or team',
          teamName: 'caller-required',
        },
      });
      const errorPayload = firstTextPayload(result);

      expect(result.isError).toBe(true);
      expect(errorPayload).toMatchObject({
        phase: 'team-preflight',
        retryValid: false,
        residualState: [],
      });
      expect(errorPayload.nextAction).toContain(
        'Do not retry this team spawn until',
      );
      expect(JSON.stringify(errorPayload)).not.toContain('missing-caller');
      expect(state.createCalls).toHaveLength(0);
      expect(state.teamMutations).toHaveLength(0);
    });
  });

  it('enforces team and fork field pairs in the success schema', () => {
    const base = {
      sessionId: 'target-session',
      adapter: 'claude-code',
      gateway: null,
      profile: null,
      cwd: '/repo',
      teamId: null,
      teamName: null,
      agentName: null,
      displayName: null,
      spawnDepth: 1,
      spawnLimits: {
        depth: { current: 0, next: 1, max: 3 },
        fanOut: {
          current: 1,
          activeChildren: 1,
          inFlight: 0,
          max: 10,
        },
        rate: {
          current: 1,
          max: 20,
          windowMs: 60_000,
          retryAfterMs: 0,
        },
      },
      sentAt: 1,
      spawnPromptMessageId: null,
    };

    expect(SPAWN_SESSION_OUTPUT_SCHEMA.safeParse({
      ...base,
      teamId: 'team-id',
    }).success).toBe(false);
    expect(SPAWN_SESSION_OUTPUT_SCHEMA.safeParse({
      ...base,
      contextMode: 'fork',
    }).success).toBe(false);
    expect(SPAWN_SESSION_OUTPUT_SCHEMA.safeParse({
      ...base,
      contextMode: 'fork',
      forkedFromSessionId: 'caller-session',
    }).success).toBe(true);
  });

  it('does not force isError results through the success output schema', async () => {
    const server = await buildAgentDeckMcpServerForExternalTransport(
      'http',
      null,
      mcpServerModule,
    );
    await withClient(server, async (client) => {
      const result = await client.callTool({
        name: 'spawn_session',
        arguments: {
          adapter: 'claude-code',
          cwd: '/repo',
          prompt: 'bounded task',
        },
      });

      expect(result.isError).toBe(true);
      expect(result.structuredContent).toBeUndefined();
      const content = result.content;
      expect(Array.isArray(content)).toBe(true);
      if (!Array.isArray(content)) throw new Error('expected MCP content array');
      const first = content[0] as { type?: unknown; text?: unknown } | undefined;
      expect(first?.type).toBe('text');
      if (typeof first?.text !== 'string') throw new Error('expected MCP text result');
      expect(JSON.parse(first.text).error).toContain('not allowed for external caller');
    });

    const error = err('failed', 'follow the hint');
    expect(error.isError).toBe(true);
    expect(error).not.toHaveProperty('structuredContent');
  });
});
