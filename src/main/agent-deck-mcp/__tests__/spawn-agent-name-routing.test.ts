/**
 * plan codex-handoff-team-alignment-20260518 §P3 Step 3.9 测试矩阵 TC3-7 —
 * spawn handler 按 args.adapter 路由 agent_name 到正确 plugin root 的 D3 矩阵验证。
 *
 * 覆盖（plan §D3 4 种异构矩阵 + plan §P3 Step 3.9 TC3-7 严格对齐）：
 * - TC3 (D3 行 1): `{adapter:'claude-code', agent_name:'reviewer-claude'}` →
 *   getBundledAssetContent 第 3 参数 = 'claude-code'
 * - TC4 (D3 行 4): `{adapter:'codex-cli', agent_name:'reviewer-claude'}` →
 *   getBundledAssetContent 第 3 参数 = 'codex-cli' (**关键 v4 修法**:codex × claude wrapper
 *   走 codex-config root,不是 claude-config; spawn.ts:102 透传 args.adapter)
 * - TC5 (D3 行 3): `{adapter:'codex-cli', agent_name:'reviewer-codex'}` →
 *   getBundledAssetContent 第 3 参数 = 'codex-cli'
 * - TC6 (D3 行 2): `{adapter:'claude-code', agent_name:'reviewer-codex'}` →
 *   getBundledAssetContent 第 3 参数 = 'claude-code'
 *
 * 测试策略：mock getBundledAssetContent 用 spy 记录 (kind, name, adapter) 三参，验证
 * spawn handler 真实透传 args.adapter 作第 3 参数（plan §D4 路由实现点）。
 *
 * mock 复用 tools.test.ts 模板（最小化 — adapterRegistry / agent-deck-team-repo / message-repo /
 * sessionManager 全部 stub 让 spawn handler 跑到 getBundledAssetContent 调用 + createSession
 * 调用即可，下游 wire prefix / placeholder enqueue 等不在本测试关注点）。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SessionRecord, AgentDeckMessage } from '@shared/types';
import { makeSessionRepoMock } from '@main/__tests__/_shared/mocks/session-repo';
import { makeSdkLoaderMock } from '@main/__tests__/_shared/mocks/sdk-loader';
import { makeSettingsStoreMock } from '@main/__tests__/_shared/mocks/settings-store';
import { makeAgentDeckTeamRepoMock } from '@main/__tests__/_shared/mocks/agent-deck-team-repo';
import type { AgentDeckTeamRepo } from '@main/store/agent-deck-team-repo';

const { sessionStore, getBundledAssetContentCalls, createSessionCalls } = vi.hoisted(() => ({
  sessionStore: new Map<string, SessionRecord>(),
  getBundledAssetContentCalls: [] as Array<{ kind: string; name: string; adapter: string }>,
  createSessionCalls: [] as Array<{
    adapter: string;
    cwd: string;
    prompt?: string;
    agentId?: string;
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
      // 仅 claude-code / codex-cli 注册;非 schema-valid adapter 由 zod enum 拒
      return {
        id,
        capabilities: {
          canCreateSession: true,
          canSetPermissionMode: id === 'claude-code',
        },
        createSession: async (opts: {
          agentId?: string;
          cwd: string;
          prompt?: string;
        }) => {
          const sid = `spawned-${nextSpawnedSid++}`;
          createSessionCalls.push({
            adapter: id,
            cwd: opts.cwd,
            prompt: opts.prompt,
            agentId: opts.agentId,
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

// **核心 mock**：getBundledAssetContent spy 记录 (kind, name, adapter) 三参（spawn.ts:102 透传
// args.adapter 作第 3 参数）。所有 (name, adapter) 组合返成功 + 仅 frontmatter / body 区分四
// 矩阵 cell，让下游 spawn handler 不 reject。
vi.mock('@main/bundled-assets', () => ({
  getBundledAssetContent: (
    kind: 'agent' | 'skill',
    name: string,
    adapter: 'claude-code' | 'codex-cli',
  ): { ok: true; content: string } | { ok: false; reason: string } => {
    getBundledAssetContentCalls.push({ kind, name, adapter });
    if (kind === 'agent') {
      // 内容随 (adapter, name) 区分让本测试可断言「真的取自正确 root」（不仅是参数透传）
      return {
        ok: true,
        content: `---\nname: ${name}\nmodel: opus\n---\n# ${adapter}/${name} body (mocked)`,
      };
    }
    return { ok: false, reason: `not found: ${kind}/${name}` };
  },
}));

// ─── 动态 import 必须放在 mock 之后 ──────────────────────────────────────
let buildAgentDeckTools: typeof import('../tools').buildAgentDeckTools;

beforeEach(async () => {
  sessionStore.clear();
  getBundledAssetContentCalls.length = 0;
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

describe('spawn handler agent_name 按 adapter 路由 (plan §P3 Step 3.9 TC3-7)', () => {
  it('TC3 (D3 行 1): claude lead × claude wrapper teammate — adapter=claude-code, agent_name=reviewer-claude → 找 claude-config root', async () => {
    const r = await spawn({
      adapter: 'claude-code',
      agent_name: 'reviewer-claude',
      cwd: '/repo',
      prompt: 'review task',
    });

    const { isError } = parseToolResult(r as any);
    expect(isError).toBeFalsy();

    expect(getBundledAssetContentCalls).toHaveLength(1);
    expect(getBundledAssetContentCalls[0]).toEqual({
      kind: 'agent',
      name: 'reviewer-claude',
      adapter: 'claude-code',
    });
    // body 被注入 prompt 前缀（spawn.ts:115）→ 真取自 claude-config root
    expect(createSessionCalls).toHaveLength(1);
    expect(createSessionCalls[0].prompt).toContain('# claude-code/reviewer-claude body');
  });

  it('TC4 (D3 行 4, v4 关键修正): codex lead × claude wrapper teammate — adapter=codex-cli, agent_name=reviewer-claude → 找 codex-config root (不是 claude-config)', async () => {
    const r = await spawn({
      adapter: 'codex-cli',
      agent_name: 'reviewer-claude',
      cwd: '/repo',
      prompt: 'review task',
    });

    const { isError } = parseToolResult(r as any);
    expect(isError).toBeFalsy();

    expect(getBundledAssetContentCalls).toHaveLength(1);
    expect(getBundledAssetContentCalls[0]).toEqual({
      kind: 'agent',
      name: 'reviewer-claude',
      adapter: 'codex-cli', // 关键：codex × claude wrapper 走 codex-config root（v3 H4 反驳后修正）
    });
    // 反 negative：**不是** claude-code（防回归到 v3 错误信号）
    expect(getBundledAssetContentCalls[0].adapter).not.toBe('claude-code');
    expect(createSessionCalls[0].prompt).toContain('# codex-cli/reviewer-claude body');
    expect(createSessionCalls[0].prompt).not.toContain('# claude-code/reviewer-claude body');
  });

  it('TC5 (D3 行 3): codex lead × codex teammate — adapter=codex-cli, agent_name=reviewer-codex → 找 codex-config root', async () => {
    const r = await spawn({
      adapter: 'codex-cli',
      agent_name: 'reviewer-codex',
      cwd: '/repo',
      prompt: 'review task',
    });

    const { isError } = parseToolResult(r as any);
    expect(isError).toBeFalsy();

    expect(getBundledAssetContentCalls).toHaveLength(1);
    expect(getBundledAssetContentCalls[0]).toEqual({
      kind: 'agent',
      name: 'reviewer-codex',
      adapter: 'codex-cli',
    });
    expect(createSessionCalls[0].prompt).toContain('# codex-cli/reviewer-codex body');
  });

  it('TC6 (D3 行 2): claude lead × codex wrapper teammate — adapter=claude-code, agent_name=reviewer-codex → 找 claude-config root', async () => {
    const r = await spawn({
      adapter: 'claude-code',
      agent_name: 'reviewer-codex',
      cwd: '/repo',
      prompt: 'review task',
    });

    const { isError } = parseToolResult(r as any);
    expect(isError).toBeFalsy();

    expect(getBundledAssetContentCalls).toHaveLength(1);
    expect(getBundledAssetContentCalls[0]).toEqual({
      kind: 'agent',
      name: 'reviewer-codex',
      adapter: 'claude-code',
    });
    expect(createSessionCalls[0].prompt).toContain('# claude-code/reviewer-codex body');
  });
});
