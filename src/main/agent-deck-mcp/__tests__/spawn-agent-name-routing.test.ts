/**
 * spawn handler 按 args.adapter 解析原生 custom agent 配置。
 *
 * 覆盖：
 * - Claude-family adapter: resolve .claude/bundled agent and pass SDK `agent` + `agents`
 * - Deepseek adapter: use Claude-family agent assets while keeping target adapter id
 * - Codex adapter: resolve official TOML agent and map it to app-server thread fields
 * - no `agentName`: generic spawn, no resolver lookup
 *
 * mock 复用 tools.test.ts 模板（最小化 — adapterRegistry / agent-deck-team-repo / message-repo /
 * sessionManager 全部 stub 让 spawn handler 跑到 resolver 调用 + createSession 调用即可，下游 wire
 * prefix / placeholder enqueue 等不在本测试关注点）。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SessionRecord, AgentDeckMessage } from '@shared/types';
import { makeSessionRepoMock } from '@main/__tests__/_shared/mocks/session-repo';
import { makeSdkLoaderMock } from '@main/__tests__/_shared/mocks/sdk-loader';
import { makeSettingsStoreMock } from '@main/__tests__/_shared/mocks/settings-store';
import { makeAgentDeckTeamRepoMock } from '@main/__tests__/_shared/mocks/agent-deck-team-repo';
import type { AgentDeckTeamRepo } from '@main/store/agent-deck-team-repo';

const {
  sessionStore,
  resolveClaudeAgentContentCalls,
  resolveCodexAgentContentCalls,
  createSessionCalls,
} = vi.hoisted(() => ({
  sessionStore: new Map<string, SessionRecord>(),
  resolveClaudeAgentContentCalls: [] as Array<{ name: string; cwd: string; adapter: string }>,
  resolveCodexAgentContentCalls: [] as Array<{ name: string; cwd: string }>,
  createSessionCalls: [] as Array<{
    adapter: string;
    cwd: string;
    prompt?: string;
    agentId?: string;
    model?: string;
    modelReasoningEffort?: string;
    developerInstructions?: string;
    codexSandbox?: string;
    codexConfigOverrides?: unknown;
    claudeAgentName?: string;
    claudeAgents?: unknown;
  }>,
}));

vi.mock('@main/store/session-repo', () => ({
  sessionRepo: makeSessionRepoMock({
    sessions: sessionStore,
    overrides: {
      setSpawnLink: (id: string, parentId: string | null, depth: number) => {
        const r = sessionStore.get(id);
        if (r) sessionStore.set(id, { ...r, spawnedBy: parentId, spawnDepth: depth });
      },
      setTitle: (id: string, title: string) => {
        const r = sessionStore.get(id);
        if (r) sessionStore.set(id, { ...r, title });
      },
      listActiveAndDormant: () => [...sessionStore.values()].slice(0, 100),
    },
  }),
}));

vi.mock('@main/session/manager', () => ({
  sessionManager: {
    close: async () => {},
    recordCreatedPermissionMode: () => {},
    notifyTeamMembershipChanged: () => {},
    get: (id: string) => sessionStore.get(id) ?? null,
  },
}));

let nextSpawnedSid = 1;

vi.mock('@main/adapters/registry', () => ({
  adapterRegistry: {
    get: (id: string) => {
      return {
        id,
        capabilities: {
          canCreateSession: true,
          canSetPermissionMode: id === 'claude-code' || id === 'deepseek-claude-code',
        },
        createSession: async (opts: {
          agentId?: string;
          cwd: string;
          prompt?: string;
          model?: string;
        }) => {
          const sid = `spawned-${nextSpawnedSid++}`;
          createSessionCalls.push({
            adapter: id,
            cwd: opts.cwd,
            prompt: opts.prompt,
            agentId: opts.agentId,
            model: opts.model,
            modelReasoningEffort: (opts as any).modelReasoningEffort,
            developerInstructions: (opts as any).developerInstructions,
            codexSandbox: (opts as any).codexSandbox,
            codexConfigOverrides: (opts as any).codexConfigOverrides,
            claudeAgentName: (opts as any).claudeAgentName,
            claudeAgents: (opts as any).claudeAgents,
          });
          sessionStore.set(sid, {
            id: sid,
            agentId: id,
            cwd: opts.cwd,
            title: '',
            source: 'sdk' as const,
            lifecycle: 'active' as const,
            activity: 'working' as const,
            startedAt: Date.now(),
            lastEventAt: Date.now(),
            endedAt: null,
            archivedAt: null,
            spawnedBy: null,
            spawnDepth: 0,
          });
          return sid;
        },
      };
    },
  },
}));

vi.mock('@main/adapters/claude-code/sdk-loader', () =>
  makeSdkLoaderMock({
    tool: <Args>(name: string, description: string, inputSchema: Args, handler: (args: any, extra: unknown) => Promise<any>) => ({
      name,
      description,
      inputSchema,
      handler,
    }),
  }),
);

vi.mock('@main/store/settings-store', () => ({
  settingsStore: makeSettingsStoreMock({
    initial: {
      mcpMaxSpawnDepth: 3,
      mcpMaxFanOutPerParent: 5,
      mcpSpawnRatePerMinute: 100,
      mcpWaitReplyIdleQuietMs: 50,
      mcpMessageRatePerTeamPerMin: 9999,
    },
  }),
}));

vi.mock('@main/store/event-repo', () => ({
  eventRepo: { listForSessionRange: () => [] },
}));

const addMemberCalls: Array<{
  teamId: string;
  sessionId: string;
  role: string;
  displayName: string | null;
}> = [];
const mockTeamMembers = new Map<
  string,
  Array<{ sessionId: string; role: string; displayName: string | null }>
>();
vi.mock('@main/store/agent-deck-team-repo', () => ({
  agentDeckTeamRepo: makeAgentDeckTeamRepoMock({
    overrides: {
      ensureByName: ((name: string) => ({
        id: `team-${name}`,
        name,
        createdAt: Date.now(),
        archivedAt: null,
        archiveReason: null,
        metadata: {},
      })) as AgentDeckTeamRepo['ensureByName'],
      addMember: ((input: {
        teamId: string;
        sessionId: string;
        role: 'lead' | 'teammate';
        displayName: string | null;
      }) => {
        addMemberCalls.push(input);
        const arr = mockTeamMembers.get(input.teamId) ?? [];
        arr.push({ sessionId: input.sessionId, role: input.role, displayName: input.displayName });
        mockTeamMembers.set(input.teamId, arr);
        return {};
      }) as unknown as AgentDeckTeamRepo['addMember'],
      findSharedActiveTeams: () => [],
      findActiveMembershipsBySession: () => [],
      findActiveMembershipsBySessionIds: () => new Map(),
      get: () => null,
      listAllMembers: ((teamId: string) =>
        mockTeamMembers.get(teamId) ?? []) as unknown as AgentDeckTeamRepo['listAllMembers'],
      hardDelete: () => true,
    },
  }),
  TeamInvariantError: class TeamInvariantError extends Error {},
}));

const mockMessages = new Map<string, AgentDeckMessage>();
let nextInsertId = 1;
vi.mock('@main/store/agent-deck-message-repo', () => ({
  agentDeckMessageRepo: {
    get: (id: string) => mockMessages.get(id) ?? null,
    insert: (input: {
      id?: string;
      teamId: string;
      fromSessionId: string;
      toSessionId: string;
      body: string;
      replyToMessageId?: string | null;
    }) => {
      const id = input.id ?? `inserted-msg-${nextInsertId++}`;
      const msg: AgentDeckMessage = {
        id,
        teamId: input.teamId,
        fromSessionId: input.fromSessionId,
        toSessionId: input.toSessionId,
        body: input.body,
        status: 'pending',
        statusReason: null,
        sentAt: Date.now(),
        deliveredAt: null,
        attemptCount: 0,
        lastAttemptAt: null,
        deliveringSince: null,
        replyToMessageId: input.replyToMessageId ?? null,
      };
      mockMessages.set(id, msg);
      return msg;
    },
    markDelivered: (id: string, _now: number) => {
      const msg = mockMessages.get(id);
      if (!msg) return null;
      if (msg.status !== 'pending' && msg.status !== 'delivering') return null;
      const updated = { ...msg, status: 'delivered' as const, deliveredAt: _now };
      mockMessages.set(id, updated);
      return updated;
    },
  },
}));

vi.mock('@main/teams/universal-message-watcher', () => ({
  enqueueAgentDeckMessage: () => ({ ok: false as const, reason: 'not-needed-for-test' }),
}));

vi.mock('@main/claude-config/custom-agents', () => ({
  resolveClaudeAgentContent: (name: string, cwd: string, adapter: 'claude-code') => {
    resolveClaudeAgentContentCalls.push({ name, cwd, adapter });
    if (name === 'missing-agent') return { ok: false, reason: `not found: ${name}` };
    return {
      ok: true,
      agent: {
        name,
        source: 'bundled',
        model: name === 'user-claude-agent' ? 'sonnet' : 'opus',
        definition: {
          description: `${adapter}/${name} description`,
          prompt: `# ${adapter}/${name} body (mocked)`,
          tools: ['Read'],
        },
      },
    };
  },
}));

vi.mock('@main/codex-config/custom-agents', () => ({
  resolveCodexAgentContent: (name: string, cwd: string) => {
    resolveCodexAgentContentCalls.push({ name, cwd });
    if (name === 'user-codex-agent' || name === 'reviewer-codex') {
      return {
        ok: true,
        agent: {
          name,
          source: 'user',
          sourcePath: '/Users/me/.codex/agents/user-codex-agent.toml',
          description: 'User Codex agent',
          developerInstructions: 'Use the user Codex custom agent instructions.',
          model: 'gpt-5.5',
          modelReasoningEffort: 'high',
          sandboxMode: 'read-only',
          config: {
            skills: {
              config: [{ name: 'agent-deck:deep-review' }],
            },
          },
        },
      };
    }
    return { ok: false, reason: `user codex miss: ${name}` };
  },
}));

// ─── 动态 import 必须放在 mock 之后 ──────────────────────────────────────
let buildAgentDeckTools: typeof import('../tools').buildAgentDeckTools;

beforeEach(async () => {
  sessionStore.clear();
  resolveClaudeAgentContentCalls.length = 0;
  resolveCodexAgentContentCalls.length = 0;
  createSessionCalls.length = 0;
  addMemberCalls.length = 0;
  mockMessages.clear();
  mockTeamMembers.clear();
  nextSpawnedSid = 1;
  nextInsertId = 1;
  if (!buildAgentDeckTools) {
    const mod = await import('../tools');
    buildAgentDeckTools = mod.buildAgentDeckTools;
  }
});

// helper：seed lead session 让 callerExists=true（spawn handler 内 sessionRepo.get(caller) 命中）
function seedLead(sid: string): void {
  sessionStore.set(sid, {
    id: sid,
    agentId: 'claude-code',
    cwd: '/repo',
    title: 'lead',
    source: 'sdk' as const,
    lifecycle: 'active' as const,
    activity: 'working' as const,
    startedAt: Date.now(),
    lastEventAt: Date.now(),
    endedAt: null,
    archivedAt: null,
    spawnedBy: null,
    spawnDepth: 0,
  });
}

// helper: build tools 实例 + 取 spawn_session handler
async function spawn(args: Record<string, unknown>, leadSid = 'lead-1') {
  seedLead(leadSid);
  const tools = await buildAgentDeckTools({
    callerSessionIdOverride: () => leadSid,
    transport: 'http',
  });
  const spawnTool = tools.find((t) => t.name === 'spawn_session');
  if (!spawnTool) throw new Error('spawn_session tool not found');
  // tool.handler signature: (args, extra) => Promise<{ content }>
  return (spawnTool as any).handler(args, undefined);
}

function parseToolResult(r: { isError?: boolean; content: Array<{ text: string }> }): {
  isError?: boolean;
  parsed: Record<string, unknown>;
} {
  return {
    isError: r.isError,
    parsed: JSON.parse(r.content[0].text) as Record<string, unknown>,
  };
}

describe('spawn handler agentName native routing', () => {
  it('Claude adapter: agentName passes SDK agent + agents, without prompt prefix injection', async () => {
    const r = await spawn({
      adapter: 'claude-code',
      agentName: 'reviewer-claude',
      cwd: '/repo',
      prompt: 'review task',
    });

    const { isError } = parseToolResult(r as any);
    expect(isError).toBeFalsy();

    expect(resolveClaudeAgentContentCalls).toEqual([{
      name: 'reviewer-claude',
      cwd: '/repo',
      adapter: 'claude-code',
    }]);
    expect(resolveCodexAgentContentCalls).toEqual([]);
    expect(createSessionCalls).toHaveLength(1);
    expect(createSessionCalls[0].prompt).toBe('review task');
    expect(createSessionCalls[0].claudeAgentName).toBe('reviewer-claude');
    expect(createSessionCalls[0].claudeAgents).toMatchObject({
      'reviewer-claude': {
        prompt: '# claude-code/reviewer-claude body (mocked)',
      },
    });
    expect(createSessionCalls[0].model).toBe('opus');
  });

  it('Codex adapter: agentName maps TOML fields to developerInstructions + thread config fields', async () => {
    const r = await spawn({
      adapter: 'codex-cli',
      agentName: 'user-codex-agent',
      cwd: '/repo',
      prompt: 'codex task',
    });

    const { isError } = parseToolResult(r as any);
    expect(isError).toBeFalsy();

    expect(resolveClaudeAgentContentCalls).toEqual([]);
    expect(resolveCodexAgentContentCalls).toEqual([{ name: 'user-codex-agent', cwd: '/repo' }]);
    expect(createSessionCalls[0].prompt).toBe('codex task');
    expect(createSessionCalls[0].developerInstructions).toContain(
      'Use the user Codex custom agent instructions.',
    );
    expect(createSessionCalls[0].developerInstructions).toContain('Description: User Codex agent');
    expect(createSessionCalls[0].model).toBe('gpt-5.5');
    expect(createSessionCalls[0].modelReasoningEffort).toBe('high');
    expect(createSessionCalls[0].codexSandbox).toBe('read-only');
    expect(createSessionCalls[0].codexConfigOverrides).toEqual({
      skills: {
        config: [{ name: 'agent-deck:deep-review' }],
      },
    });
  });

  it('Deepseek adapter: resolves Claude-family agent assets while target adapter remains deepseek', async () => {
    const r = await spawn({
      adapter: 'deepseek-claude-code',
      agentName: 'reviewer-claude',
      cwd: '/repo',
      prompt: 'review task',
    });

    const { isError } = parseToolResult(r as any);
    expect(isError).toBeFalsy();

    expect(resolveClaudeAgentContentCalls).toEqual([{
      name: 'reviewer-claude',
      cwd: '/repo',
      adapter: 'claude-code',
    }]);
    expect(createSessionCalls).toHaveLength(1);
    expect(createSessionCalls[0].adapter).toBe('deepseek-claude-code');
    expect(createSessionCalls[0].claudeAgentName).toBe('reviewer-claude');
  });

  it('explicit model overrides bundled agent frontmatter model', async () => {
    const r = await spawn({
      adapter: 'claude-code',
      agentName: 'reviewer-claude',
      cwd: '/repo',
      prompt: 'review task',
      model: 'sonnet',
    });

    const { isError } = parseToolResult(r as any);
    expect(isError).toBeFalsy();
    expect(createSessionCalls).toHaveLength(1);
    // mock agent frontmatter has `model: opus`; explicit tool param wins.
    expect(createSessionCalls[0].model).toBe('sonnet');
  });

  it('generic spawn does not resolve any custom agent when agentName is omitted', async () => {
    const r = await spawn({
      adapter: 'claude-code',
      cwd: '/repo',
      prompt: 'patch task',
    });

    const { isError } = parseToolResult(r as any);
    expect(isError).toBeFalsy();
    expect(resolveClaudeAgentContentCalls).toEqual([]);
    expect(resolveCodexAgentContentCalls).toEqual([]);
    expect(createSessionCalls[0].prompt).toBe('patch task');
    expect(createSessionCalls[0].claudeAgentName).toBeUndefined();
    expect(createSessionCalls[0].claudeAgents).toBeUndefined();
  });

  it('unknown agentName rejects instead of falling back to generic prompt', async () => {
    const r = await spawn({
      adapter: 'claude-code',
      agentName: 'missing-agent',
      cwd: '/repo',
      prompt: 'patch task',
    });

    const { isError, parsed } = parseToolResult(r as any);
    expect(isError).toBe(true);
    expect(parsed.error).toContain('agent not found');
    expect(createSessionCalls).toEqual([]);
  });
});
