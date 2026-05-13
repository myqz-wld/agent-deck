/**
 * Agent Deck MCP server B'2.a tool handler 决策单测。
 *
 * 不依赖真实 SQLite / Electron / SDK 子进程：用 vi.mock 把 sessionRepo /
 * sessionManager / adapterRegistry 替换为内存 stub，验证：
 *
 * - external caller（__external__）对 spawn / send / shutdown 自动 deny
 * - in-process closure 强制覆盖 args.caller_session_id（验证防 prompt 注入）
 * - HTTP/stdio caller 反查 sessionManager 不存在 / 已 closed 时 deny
 * - shutdown_session(self) deny
 * - send_message 目标 session closed 时 deny
 * - list_sessions 投影 metadata 不含 events / messages
 * - spawn_session same-cwd same-adapter 是合法路径（REVIEW_28 移除 §6.2 后）
 *
 * 完整防递归 3 条规则（depth / fan-out / spawn-rate）的单测放 spawn-guards.test.ts。
 * wait_reply coordinator + backfill 单测放 wait-reply-coordinator.test.ts。
 */

import { describe, expect, it, vi, beforeEach } from 'vitest';
import type { SessionRecord, AgentDeckMessage } from '@shared/types';
import { eventBus } from '@main/event-bus';

// ─── Mock: sessionRepo / sessionManager / adapterRegistry ──────────────

const sessionStore = new Map<string, SessionRecord>();
const setSpawnLinkCalls: Array<{ id: string; parentId: string | null; depth: number }> = [];
// REVIEW_31 Bug 4: spawn_session display_name fallback 链验证
const setTitleCalls: Array<{ id: string; title: string }> = [];

vi.mock('@main/store/session-repo', () => ({
  sessionRepo: {
    get: (id: string) => sessionStore.get(id) ?? null,
    listActiveAndDormant: () => [...sessionStore.values()].slice(0, 100),
    listHistory: () => [],
    getSpawnDepth: (id: string) => sessionStore.get(id)?.spawnDepth ?? 0,
    setSpawnLink: (id: string, parentId: string | null, depth: number) => {
      setSpawnLinkCalls.push({ id, parentId, depth });
      const r = sessionStore.get(id);
      if (r) sessionStore.set(id, { ...r, spawnedBy: parentId, spawnDepth: depth });
    },
    setTitle: (id: string, title: string) => {
      setTitleCalls.push({ id, title });
      const r = sessionStore.get(id);
      if (r) sessionStore.set(id, { ...r, title });
    },
    listAncestors: (id: string) => {
      const out: SessionRecord[] = [];
      let cursor = sessionStore.get(id);
      const visited = new Set<string>([id]);
      while (cursor && cursor.spawnedBy && !visited.has(cursor.spawnedBy)) {
        visited.add(cursor.spawnedBy);
        const parent = sessionStore.get(cursor.spawnedBy);
        if (!parent) break;
        out.push(parent);
        cursor = parent;
      }
      return out;
    },
    listChildren: (parentId: string) =>
      [...sessionStore.values()].filter(
        (s) => s.spawnedBy === parentId && s.lifecycle === 'active',
      ),
  },
}));

const closeCalls: string[] = [];
const recordPermCalls: Array<{ sid: string; mode: string | undefined }> = [];
const notifyTeamCalls: string[] = [];

vi.mock('@main/session/manager', () => ({
  sessionManager: {
    close: async (id: string) => {
      closeCalls.push(id);
      const r = sessionStore.get(id);
      if (r) sessionStore.set(id, { ...r, lifecycle: 'closed' });
    },
    recordCreatedPermissionMode: (sid: string, mode: string | undefined) => {
      recordPermCalls.push({ sid, mode });
    },
    // plan team-cohesion-fix-20260513 Phase A：universal team backend 写入 hook
    notifyTeamMembershipChanged: (sid: string) => {
      notifyTeamCalls.push(sid);
    },
    // get / list / enrichWithTeams 内部走 sessionStore + mockMembershipsBySession
    get: (id: string) => {
      const rec = sessionStore.get(id);
      if (!rec) return null;
      const teams = (mockMembershipsBySession.get(id) ?? []).map((m) => ({
        teamId: m.teamId,
        teamName: mockTeamsById.get(m.teamId)?.name ?? '<unknown>',
        role: 'teammate' as const,
        joinedAt: Date.now(),
      }));
      return { ...rec, teams };
    },
    enrichWithTeams: (rec: SessionRecord) => {
      const teams = (mockMembershipsBySession.get(rec.id) ?? []).map((m) => ({
        teamId: m.teamId,
        teamName: mockTeamsById.get(m.teamId)?.name ?? '<unknown>',
        role: 'teammate' as const,
        joinedAt: Date.now(),
      }));
      return { ...rec, teams };
    },
    enrichWithTeamsBatch: (recs: SessionRecord[]) =>
      recs.map((rec) => {
        const teams = (mockMembershipsBySession.get(rec.id) ?? []).map((m) => ({
          teamId: m.teamId,
          teamName: mockTeamsById.get(m.teamId)?.name ?? '<unknown>',
          role: 'teammate' as const,
          joinedAt: Date.now(),
        }));
        return { ...rec, teams };
      }),
  },
}));

let nextSpawnedSid = 'spawned-1';
const sendMessageCalls: Array<{ sid: string; text: string }> = [];

// D1 (CHANGELOG_76): spy createSession opts 让 test 能断言 prompt 是否被 body 前缀注入。
const createSessionCalls: Array<{ adapter: string; cwd: string; prompt?: string; teamName?: string }> = [];

vi.mock('@main/adapters/registry', () => ({
  adapterRegistry: {
    get: (id: string) => {
      if (id !== 'claude-code' && id !== 'codex-cli') return undefined;
      return {
        id,
        capabilities: {
          canCreateSession: true,
          canSetPermissionMode: id === 'claude-code',
        },
        createSession: async (opts: { cwd: string; prompt?: string; teamName?: string }) => {
          const sid = nextSpawnedSid;
          createSessionCalls.push({ adapter: id, cwd: opts.cwd, prompt: opts.prompt, teamName: opts.teamName });
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
        sendMessage: async (sid: string, text: string) => {
          sendMessageCalls.push({ sid, text });
        },
      };
    },
  },
}));

// SDK loader 必须 mock —— 真实 loader 会动态 import @anthropic-ai/claude-agent-sdk
// 拉起底层 wasm，单测不需要实际 SDK
vi.mock('@main/adapters/claude-code/sdk-loader', () => ({
  loadSdk: async () => ({
    tool: <Args>(name: string, description: string, inputSchema: Args, handler: (args: any, extra: unknown) => Promise<any>) => ({
      name,
      description,
      inputSchema,
      handler,
    }),
  }),
}));

// settingsStore 走 electron-store / Electron app —— 测试环境拉不起来；
// 这里仅给 mcpWaitReplyIdleQuietMs 默认值就够（其他 setting 测试不读）。
vi.mock('@main/store/settings-store', () => ({
  settingsStore: {
    get: (key: string) => {
      if (key === 'mcpWaitReplyIdleQuietMs') return 50; // 短一点让 idle 测试快返
      if (key === 'mcpMessageRatePerTeamPerMin') return 9999; // 测试不限流
      return undefined;
    },
    getAll: () => ({
      // spawn-guards 读这些字段；测试默认给宽松值不阻塞 spawn 测试
      mcpMaxSpawnDepth: 3,
      mcpMaxFanOutPerParent: 5,
      mcpSpawnRatePerMinute: 100, // 测试调高，避免 21 测试连环 spawn 触发限流
      mcpWaitReplyIdleQuietMs: 50,
    }),
  },
}));

// eventRepo backfill 单元用空数组（B'2.b backfill 行为在专门测试里覆盖）
vi.mock('@main/store/event-repo', () => ({
  eventRepo: {
    listForSessionRange: () => [],
  },
}));

// R3.E8 mock：agent-deck-team-repo + universal-message-watcher（spawn_session ensure-team /
// send_message route via DB envelope）。测试不实际操作 SQLite，只验证 handler 决策。
const enqueuedMessages: Array<{ teamId: string; fromSessionId: string; toSessionId: string; body: string }> = [];
const sharedTeamsBySession = new Map<string, string[]>();
function setSharedTeams(a: string, b: string, teamIds: string[]): void {
  const key = [a, b].sort().join(':');
  sharedTeamsBySession.set(key, teamIds);
}

// D3 (CHANGELOG_76): stateful mock 让测试动态注入「session → active memberships」与「teamId → team」
// 用于验证 projectSession 反查 teamName。默认空 → projectSession 回落到 `s.teamName`，
// 保持现有非 D3 测试维持原行为。
const mockMembershipsBySession = new Map<string, Array<{ teamId: string }>>();
const mockTeamsById = new Map<string, { name: string }>();

// REVIEW_31 Bug 4：addMember mock 改成记录调用让测试断言 displayName fallback 链
const addMemberCalls: Array<{ teamId: string; sessionId: string; role: string; displayName: string | null }> = [];

vi.mock('@main/store/agent-deck-team-repo', () => ({
  agentDeckTeamRepo: {
    ensureByName: (name: string) => ({
      id: `team-${name}`,
      name,
      createdAt: Date.now(),
      archivedAt: null,
      metadata: {},
    }),
    addMember: (input: {
      teamId: string;
      sessionId: string;
      role: 'lead' | 'teammate';
      displayName: string | null;
    }) => {
      addMemberCalls.push(input);
      return {};
    },
    findSharedActiveTeams: (a: string, b: string): string[] => {
      const key = [a, b].sort().join(':');
      return sharedTeamsBySession.get(key) ?? [];
    },
    // plan team-cohesion-fix-20260513 Phase A Step A2/A7：批量反查 (sessionManager.enrichWithTeamsBatch 用)
    findActiveMembershipsBySessionIds: (sids: string[]) => {
      const map = new Map<string, Array<{ teamId: string; teamName: string; role: 'teammate'; joinedAt: number }>>();
      for (const sid of sids) {
        const memberships = mockMembershipsBySession.get(sid);
        if (!memberships) continue;
        map.set(
          sid,
          memberships.map((m) => ({
            teamId: m.teamId,
            teamName: mockTeamsById.get(m.teamId)?.name ?? '<unknown>',
            role: 'teammate' as const,
            joinedAt: Date.now(),
          })),
        );
      }
      return map;
    },
    findActiveMembershipsBySession: (sid: string) => mockMembershipsBySession.get(sid) ?? [],
    get: (teamId: string) => mockTeamsById.get(teamId) ?? null,
  },
  TeamInvariantError: class TeamInvariantError extends Error {},
}));
// plan team-cohesion-fix-20260513 Phase B：mock agent-deck-message-repo for wait_reply tests
const mockMessages = new Map<string, AgentDeckMessage>();
const mockReplies = new Map<string, AgentDeckMessage[]>();
const insertedMessages: Array<{ id: string; teamId: string; fromSessionId: string; toSessionId: string; body: string; replyToMessageId: string | null }> = [];
const markedDelivered: string[] = [];
let nextInsertId = 1;

vi.mock('@main/store/agent-deck-message-repo', () => ({
  agentDeckMessageRepo: {
    get: (id: string) => mockMessages.get(id) ?? null,
    findRepliesByMessageId: (id: string) => mockReplies.get(id) ?? [],
    insert: (input: { id?: string; teamId: string; fromSessionId: string; toSessionId: string; body: string; replyToMessageId?: string | null }) => {
      // plan team-cohesion-fix-20260513 Phase B7：input.id 非空 → 用之（spawn 路径预生成 id 注入 wire prefix）；
      // 否则 fallback 自增 mock id（其他路径如 enqueueAgentDeckMessage 仍走原行为）。
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
      insertedMessages.push({
        id,
        teamId: input.teamId,
        fromSessionId: input.fromSessionId,
        toSessionId: input.toSessionId,
        body: input.body,
        replyToMessageId: input.replyToMessageId ?? null,
      });
      mockMessages.set(id, msg);
      return msg;
    },
    markDelivered: (id: string, _now: number) => {
      markedDelivered.push(id);
      const msg = mockMessages.get(id);
      // REVIEW_32 HIGH-1：mock 与生产 SQL 行为对齐（仅 status IN ('pending','delivering') 才切到 delivered，
      // 否则 no-op 返 null）。旧版无条件改 status='delivered' 与生产 SQL `WHERE status='delivering'` 漂移，
      // spawn placeholder（status='pending'）单测显示 OK 实际生产 100% no-op，REVIEW_31 Bug 1+2 同款盲区。
      if (!msg) return null;
      if (msg.status !== 'pending' && msg.status !== 'delivering') return null;
      const updated = { ...msg, status: 'delivered' as const, deliveredAt: _now };
      mockMessages.set(id, updated);
      return updated;
    },
  },
}));

vi.mock('@main/teams/universal-message-watcher', () => ({
  enqueueAgentDeckMessage: (input: { teamId: string; fromSessionId: string; toSessionId: string; body: string }) => {
    enqueuedMessages.push(input);
    return {
      ok: true as const,
      message: {
        id: `msg-${enqueuedMessages.length}`,
        teamId: input.teamId,
        fromSessionId: input.fromSessionId,
        toSessionId: input.toSessionId,
        body: input.body,
        status: 'pending' as const,
        statusReason: null,
        sentAt: Date.now(),
        deliveredAt: null,
        attemptCount: 0,
        lastAttemptAt: null,
        deliveringSince: null,
      },
    };
  },
}));

// D1 (CHANGELOG_76 / plan deep-review-flow-fix): spawn_session 加 agent_name 时 handler
// 调 getBundledAssetContent 拼 body 到 prompt 头部。mock 提供 reviewer-claude 假 body，
// 其他 name 返回失败（模拟「找不到」）。
//
// REVIEW_31 Bug 1+2 修法：mock 必须严格按真实签名 `{ok:true,content} | {ok:false,reason}`，
// 否则 handler call-site 当 string|null 用就会 toString 成 "[object Object]"，单测看不出来
// 但生产 100% 失败（用户实测 SKILL spawn 出来 reviewer 收到的 prompt 顶部是 [object Object]
// 紧跟 ---\n\n + 任务体，agent body 完全没注入）。
vi.mock('@main/bundled-assets', () => ({
  getBundledAssetContent: (
    kind: 'agent' | 'skill',
    name: string,
  ): { ok: true; content: string } | { ok: false; reason: string } => {
    if (kind === 'agent' && name === 'reviewer-claude') {
      return {
        ok: true,
        content: '# REVIEWER-CLAUDE BODY (mocked)\n你是对抗 reviewer。',
      };
    }
    return { ok: false, reason: `not found: ${kind}/${name}` };
  },
}));

// ─── 动态 import 必须放在 mock 之后 ──────────────────────────────────────

let buildAgentDeckTools: typeof import('../tools').buildAgentDeckTools;

beforeEach(async () => {
  sessionStore.clear();
  setSpawnLinkCalls.length = 0;
  setTitleCalls.length = 0;
  addMemberCalls.length = 0;
  closeCalls.length = 0;
  notifyTeamCalls.length = 0;
  recordPermCalls.length = 0;
  sendMessageCalls.length = 0;
  createSessionCalls.length = 0;
  enqueuedMessages.length = 0;
  sharedTeamsBySession.clear();
  mockMembershipsBySession.clear();
  mockTeamsById.clear();
  mockMessages.clear();
  mockReplies.clear();
  insertedMessages.length = 0;
  markedDelivered.length = 0;
  nextInsertId = 1;
  nextSpawnedSid = 'spawned-1';
  // 重新 import 让 mock 生效
  if (!buildAgentDeckTools) {
    const mod = await import('../tools');
    buildAgentDeckTools = mod.buildAgentDeckTools;
  }
});

// ─── 测试 helpers ─────────────────────────────────────────────────────

async function getTools(opts: {
  callerSessionIdOverride?: () => string | null;
  transport?: 'in-process' | 'http' | 'stdio';
}) {
  const tools = await buildAgentDeckTools({
    callerSessionIdOverride: opts.callerSessionIdOverride ?? null,
    transport: opts.transport ?? 'http',
  });
  const byName = new Map<string, any>();
  for (const t of tools) byName.set((t as any).name, t);
  return byName;
}

function seedSession(sid: string, opts: Partial<SessionRecord> = {}) {
  sessionStore.set(sid, {
    id: sid,
    agentId: 'claude-code',
    cwd: '/repo',
    title: 'test',
    source: 'sdk' as const,
    lifecycle: 'active' as const,
    activity: 'working' as const,
    startedAt: Date.now(),
    lastEventAt: Date.now(),
    endedAt: null,
    archivedAt: null,
    spawnedBy: null,
    spawnDepth: 0,
    ...opts,
  });
}

function parseResult(result: any): { isError?: boolean; data: any } {
  const content = result.content?.[0]?.text;
  return { isError: result.isError, data: JSON.parse(content) };
}

// ─── Tests ────────────────────────────────────────────────────────────

describe('agent-deck-mcp tools — external caller deny', () => {
  it('spawn_session denies __external__ caller', async () => {
    const tools = await getTools({ transport: 'stdio' });
    const r = await tools.get('spawn_session').handler({
      adapter: 'claude-code',
      cwd: '/tmp',
      prompt: 'hello',
      caller_session_id: '__external__',
    }, {});
    const parsed = parseResult(r);
    expect(parsed.isError).toBe(true);
    expect(parsed.data.error).toMatch(/not allowed for external caller/);
  });

  it('list_sessions ALLOWS __external__ caller (read-only)', async () => {
    const tools = await getTools({ transport: 'stdio' });
    seedSession('lead-1');
    const r = await tools.get('list_sessions').handler({
      caller_session_id: '__external__',
      status_filter: 'active',
      limit: 50,
    }, {});
    const parsed = parseResult(r);
    expect(parsed.isError).toBeFalsy();
    expect(parsed.data.sessions).toHaveLength(1);
  });

  it('shutdown_session denies __external__ caller', async () => {
    const tools = await getTools({ transport: 'stdio' });
    const r = await tools.get('shutdown_session').handler({
      session_id: 'target',
      caller_session_id: '__external__',
    }, {});
    const parsed = parseResult(r);
    expect(parsed.isError).toBe(true);
  });
});

describe('agent-deck-mcp tools — caller validation (HTTP/stdio)', () => {
  it('rejects unknown caller_session_id', async () => {
    const tools = await getTools({ transport: 'http' });
    const r = await tools.get('list_sessions').handler({
      caller_session_id: 'nonexistent-sid',
      status_filter: 'active',
      limit: 50,
    }, {});
    const parsed = parseResult(r);
    expect(parsed.isError).toBe(true);
    expect(parsed.data.error).toMatch(/unknown caller_session_id/);
  });

  it('rejects closed caller_session_id', async () => {
    const tools = await getTools({ transport: 'http' });
    seedSession('closed-lead', { lifecycle: 'closed' });
    const r = await tools.get('send_message').handler({
      session_id: 'whatever',
      text: 'hi',
      caller_session_id: 'closed-lead',
    }, {});
    const parsed = parseResult(r);
    expect(parsed.isError).toBe(true);
    expect(parsed.data.error).toMatch(/is closed/);
  });

  it('in-process closure overrides args.caller_session_id (anti-injection)', async () => {
    const realCaller = 'real-lead';
    seedSession(realCaller);
    const tools = await getTools({
      transport: 'in-process',
      callerSessionIdOverride: () => realCaller,
    });
    seedSession('target');
    // LLM 试图伪造 caller_session_id 为 fake-id；in-process 应该静默用真实 closure id
    const r = await tools.get('shutdown_session').handler({
      session_id: 'target',
      caller_session_id: 'fake-id',
    }, {});
    const parsed = parseResult(r);
    // 不应该报「unknown caller」（因为 closure 注入了 real-lead），应该走完正常路径成功 close
    expect(parsed.isError).toBeFalsy();
    expect(closeCalls).toEqual(['target']);
  });
});

describe('agent-deck-mcp tools — spawn_session', () => {
  // REVIEW_28：原 §6.2 cwd cycle 检测移除后，「same-cwd same-adapter spawn」是合法用例
  // （deep-code-review SKILL：lead 在 repo 起 reviewer teammate 同 cwd 同 adapter）。
  // 防递归靠 §6.1 depth + §6.4 fan-out + §6.3 spawn-rate 三条兜底（spawn-guards.test.ts 覆盖）。

  it('allows same cwd same adapter (deep-code-review SKILL 合法路径)', async () => {
    const tools = await getTools({ transport: 'http' });
    seedSession('lead', { cwd: '/repo', agentId: 'claude-code' });
    const r = await tools.get('spawn_session').handler({
      adapter: 'claude-code',
      cwd: '/repo',
      prompt: 'reviewer teammate prompt',
      caller_session_id: 'lead',
    }, {});
    const parsed = parseResult(r);
    expect(parsed.isError).toBeFalsy();
    expect(parsed.data.sessionId).toBe('spawned-1');
    expect(setSpawnLinkCalls).toEqual([
      { id: 'spawned-1', parentId: 'lead', depth: 1 },
    ]);
  });

  it('allows different cwd same adapter', async () => {
    const tools = await getTools({ transport: 'http' });
    seedSession('lead', { cwd: '/repo', agentId: 'claude-code' });
    const r = await tools.get('spawn_session').handler({
      adapter: 'claude-code',
      cwd: '/repo/sub',
      prompt: 'isolated task',
      caller_session_id: 'lead',
    }, {});
    const parsed = parseResult(r);
    expect(parsed.isError).toBeFalsy();
    expect(parsed.data.sessionId).toBe('spawned-1');
    expect(setSpawnLinkCalls).toEqual([
      { id: 'spawned-1', parentId: 'lead', depth: 1 },
    ]);
  });

  it('allows same cwd different adapter (heterogeneous reviewer pair)', async () => {
    const tools = await getTools({ transport: 'http' });
    seedSession('lead', { cwd: '/repo', agentId: 'claude-code' });
    const r = await tools.get('spawn_session').handler({
      adapter: 'codex-cli', // 不同 adapter
      cwd: '/repo',
      prompt: 'reviewer-codex agent body',
      caller_session_id: 'lead',
    }, {});
    const parsed = parseResult(r);
    expect(parsed.isError).toBeFalsy();
  });

  it('records team membership when team_name provided', async () => {
    const tools = await getTools({ transport: 'http' });
    seedSession('lead', { cwd: '/repo' });
    const r = await tools.get('spawn_session').handler({
      adapter: 'codex-cli',
      cwd: '/repo',
      prompt: 'p',
      team_name: 'review-team',
      caller_session_id: 'lead',
    }, {});
    const parsed = parseResult(r);
    expect(parsed.isError).toBeFalsy();
    // plan team-cohesion-fix-20260513 Phase A Step A8：sessionManager.recordCreatedTeamName 已删，
    // spawn_session 改走 universal team backend addMember + notifyTeamMembershipChanged。
    // 验证 lead + teammate 都被 notify 触发桥点 enrich。
    expect(notifyTeamCalls).toContain('lead');
    expect(notifyTeamCalls).toContain('spawned-1');
  });

  it('Phase B5+B7 方案 A: spawn 返 placeholder spawnPromptMessageId + wire format 注入 [msg <id>]', async () => {
    const tools = await getTools({ transport: 'http' });
    seedSession('lead', { cwd: '/repo' });
    const r = await tools.get('spawn_session').handler({
      adapter: 'codex-cli',
      cwd: '/repo',
      prompt: 'review src/foo.ts',
      team_name: 'review-team',
      caller_session_id: 'lead',
    }, {});
    const parsed = parseResult(r);
    expect(parsed.isError).toBeFalsy();
    // Phase B5: spawn 返 spawnPromptMessageId 非空（Phase B7：UUID v4 形式，由 spawn 预生成）
    const spawnId = parsed.data.spawnPromptMessageId;
    expect(spawnId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    // Phase B7: createSession 收到的 prompt 顶部含 wire prefix `[msg <spawnPromptMessageId>]\n`
    // 让 teammate 能 regex 提 messageId 调 reply_message。
    expect(createSessionCalls).toHaveLength(1);
    expect(createSessionCalls[0].prompt).toBe(`[msg ${spawnId}]\nreview src/foo.ts`);
    // Phase B5: messages 表 placeholder body 是**原始 promptToUse**（不含 wire prefix）
    expect(insertedMessages).toHaveLength(1);
    expect(insertedMessages[0]).toEqual({
      id: spawnId,
      teamId: 'team-review-team',
      fromSessionId: 'lead',
      toSessionId: 'spawned-1',
      body: 'review src/foo.ts',
      replyToMessageId: null,
    });
    // 立即 mark delivered（不重复投递，SDK 已通过 createSession.prompt 收过）
    expect(markedDelivered).toEqual([spawnId]);
  });

  it('Phase B7: spawn without team_name skips wire prefix injection (no placeholder)', async () => {
    const tools = await getTools({ transport: 'http' });
    seedSession('lead', { cwd: '/repo' });
    const r = await tools.get('spawn_session').handler({
      adapter: 'codex-cli',
      cwd: '/repo',
      prompt: 'standalone task',
      // 不传 team_name → 不创建 placeholder + 不注入 prefix
      caller_session_id: 'lead',
    }, {});
    const parsed = parseResult(r);
    expect(parsed.isError).toBeFalsy();
    expect(parsed.data.spawnPromptMessageId).toBeNull();
    expect(createSessionCalls).toHaveLength(1);
    expect(createSessionCalls[0].prompt).toBe('standalone task');  // 原样，无 prefix
    expect(insertedMessages).toEqual([]);  // 无 team_name 不入 placeholder
  });

  it('Phase B7: spawn with agent_name + team_name → wire prefix on top of injected agent body', async () => {
    const tools = await getTools({ transport: 'http' });
    seedSession('lead', { cwd: '/repo' });
    const r = await tools.get('spawn_session').handler({
      adapter: 'claude-code',
      cwd: '/repo',
      prompt: 'task body: review src/foo.ts',
      agent_name: 'reviewer-claude',
      team_name: 'review-team',
      caller_session_id: 'lead',
    }, {});
    const parsed = parseResult(r);
    expect(parsed.isError).toBeFalsy();
    const spawnId = parsed.data.spawnPromptMessageId;
    expect(spawnId).toMatch(/^[0-9a-f-]{36}$/);
    // wire prefix 在最顶 + agent body + caller prompt 顺序：
    expect(createSessionCalls[0].prompt).toBe(
      `[msg ${spawnId}]\n# REVIEWER-CLAUDE BODY (mocked)\n你是对抗 reviewer。\n\n---\n\ntask body: review src/foo.ts`,
    );
    // DB body 不含 wire prefix（保留 agent body + ---\n\n + caller prompt 形态）
    expect(insertedMessages[0].body).toBe(
      `# REVIEWER-CLAUDE BODY (mocked)\n你是对抗 reviewer。\n\n---\n\ntask body: review src/foo.ts`,
    );
  });

  it('rejects unknown adapter', async () => {
    const tools = await getTools({ transport: 'http' });
    seedSession('lead');
    const r = await tools.get('spawn_session').handler({
      adapter: 'aider', // adapter mock 只 register 了 claude-code/codex-cli
      cwd: '/elsewhere',
      prompt: 'p',
      caller_session_id: 'lead',
    }, {});
    const parsed = parseResult(r);
    expect(parsed.isError).toBe(true);
    expect(parsed.data.error).toMatch(/cannot create sessions/);
  });

  // D1 (CHANGELOG_76 / plan deep-review-flow-fix): agent_name 自动注入 plugin agent body
  it('agent_name auto-prepends plugin agent body to prompt', async () => {
    const tools = await getTools({ transport: 'http' });
    seedSession('lead', { cwd: '/repo' });
    const r = await tools.get('spawn_session').handler({
      adapter: 'claude-code',
      cwd: '/repo',
      prompt: 'task body: review src/foo.ts',
      agent_name: 'reviewer-claude',
      caller_session_id: 'lead',
    }, {});
    const parsed = parseResult(r);
    expect(parsed.isError).toBeFalsy();
    expect(createSessionCalls).toHaveLength(1);
    expect(createSessionCalls[0].prompt).toMatch(/REVIEWER-CLAUDE BODY \(mocked\)/);
    expect(createSessionCalls[0].prompt).toMatch(/task body: review src\/foo\.ts/);
    // 顺序验证：body 在前，分隔符 + task body 在后
    const idx = createSessionCalls[0].prompt!.indexOf('task body: review');
    const bodyIdx = createSessionCalls[0].prompt!.indexOf('REVIEWER-CLAUDE BODY');
    expect(bodyIdx).toBeLessThan(idx);
  });

  it('agent_name unresolved → returns err (no fallback to bare prompt)', async () => {
    const tools = await getTools({ transport: 'http' });
    seedSession('lead', { cwd: '/repo' });
    const r = await tools.get('spawn_session').handler({
      adapter: 'claude-code',
      cwd: '/repo',
      prompt: 'task body',
      agent_name: 'nonexistent-agent',
      caller_session_id: 'lead',
    }, {});
    const parsed = parseResult(r);
    expect(parsed.isError).toBe(true);
    expect(parsed.data.error).toMatch(/agent body not found/);
    // 没静默 spawn
    expect(createSessionCalls).toHaveLength(0);
  });

  it('agent_name omitted → prompt unchanged (backward compatible)', async () => {
    const tools = await getTools({ transport: 'http' });
    seedSession('lead', { cwd: '/repo' });
    const r = await tools.get('spawn_session').handler({
      adapter: 'claude-code',
      cwd: '/repo',
      prompt: 'plain prompt without body',
      caller_session_id: 'lead',
    }, {});
    const parsed = parseResult(r);
    expect(parsed.isError).toBeFalsy();
    expect(createSessionCalls).toHaveLength(1);
    expect(createSessionCalls[0].prompt).toBe('plain prompt without body');
  });

  // REVIEW_31 Bug 1+2 regression：handler 必须正确解 getBundledAssetContent 的 union
  // 返回（{ok:true,content} 形态），而不是当 string 用。老 bug 现象：模板字符串
  // 拿到 object 走 toString → "[object Object]"，agent body 完全没注入到 prompt。
  // 这条 case 显式断言 spawn 后 prompt **不含** "[object Object]" 且**含** mock content
  // 真实文本，并锁住 placeholder DB body 同样真实形态。
  it('regression Bug 1+2: agent body union unpacked correctly (no [object Object])', async () => {
    const tools = await getTools({ transport: 'http' });
    seedSession('lead', { cwd: '/repo' });
    const r = await tools.get('spawn_session').handler({
      adapter: 'claude-code',
      cwd: '/repo',
      prompt: 'task body',
      agent_name: 'reviewer-claude',
      team_name: 'review-team',
      caller_session_id: 'lead',
    }, {});
    const parsed = parseResult(r);
    expect(parsed.isError).toBeFalsy();
    expect(createSessionCalls[0].prompt).not.toContain('[object Object]');
    expect(createSessionCalls[0].prompt).toContain('# REVIEWER-CLAUDE BODY (mocked)');
    expect(createSessionCalls[0].prompt).toContain('你是对抗 reviewer。');
    // DB body 同样不含 [object Object]
    expect(insertedMessages[0].body).not.toContain('[object Object]');
    expect(insertedMessages[0].body).toContain('# REVIEWER-CLAUDE BODY (mocked)');
  });

  // REVIEW_31 Bug 4：teammate display name fallback 链 = display_name > agent_name > 不动。
  it('Bug 4: display_name overrides agent_name for both session.title and team_member.display_name', async () => {
    const tools = await getTools({ transport: 'http' });
    seedSession('lead', { cwd: '/repo' });
    const r = await tools.get('spawn_session').handler({
      adapter: 'claude-code',
      cwd: '/repo',
      prompt: 'task body',
      agent_name: 'reviewer-claude',
      display_name: 'reviewer-claude · batch A',
      team_name: 'review-team',
      caller_session_id: 'lead',
    }, {});
    const parsed = parseResult(r);
    expect(parsed.isError).toBeFalsy();
    const newSid = parsed.data.sessionId;
    // session.title 走 display_name（覆盖默认 cwd-basename）
    expect(setTitleCalls).toContainEqual({ id: newSid, title: 'reviewer-claude · batch A' });
    // team_member.displayName 同步走 display_name；lead 仍 displayName=null（lead 无 fallback 链）
    const teammateAdd = addMemberCalls.find((c) => c.sessionId === newSid && c.role === 'teammate');
    expect(teammateAdd?.displayName).toBe('reviewer-claude · batch A');
    const leadAdd = addMemberCalls.find((c) => c.sessionId === 'lead' && c.role === 'lead');
    expect(leadAdd?.displayName).toBeNull();
  });

  it('Bug 4: agent_name fallback when display_name omitted', async () => {
    const tools = await getTools({ transport: 'http' });
    seedSession('lead', { cwd: '/repo' });
    const r = await tools.get('spawn_session').handler({
      adapter: 'claude-code',
      cwd: '/repo',
      prompt: 'task body',
      agent_name: 'reviewer-claude',
      team_name: 'review-team',
      caller_session_id: 'lead',
    }, {});
    const parsed = parseResult(r);
    expect(parsed.isError).toBeFalsy();
    const newSid = parsed.data.sessionId;
    expect(setTitleCalls).toContainEqual({ id: newSid, title: 'reviewer-claude' });
    const teammateAdd = addMemberCalls.find((c) => c.sessionId === newSid && c.role === 'teammate');
    expect(teammateAdd?.displayName).toBe('reviewer-claude');
  });

  it('Bug 4: no display_name + no agent_name → setTitle skipped (default cwd-basename preserved)', async () => {
    const tools = await getTools({ transport: 'http' });
    seedSession('lead', { cwd: '/repo' });
    const r = await tools.get('spawn_session').handler({
      adapter: 'claude-code',
      cwd: '/repo',
      prompt: 'naked spawn',
      team_name: 'review-team',
      caller_session_id: 'lead',
    }, {});
    const parsed = parseResult(r);
    expect(parsed.isError).toBeFalsy();
    const newSid = parsed.data.sessionId;
    // 无 display_name / agent_name → 不调 setTitle，保留默认 title
    expect(setTitleCalls.find((c) => c.id === newSid)).toBeUndefined();
    const teammateAdd = addMemberCalls.find((c) => c.sessionId === newSid && c.role === 'teammate');
    expect(teammateAdd?.displayName).toBeNull();
  });
});

describe('agent-deck-mcp tools — send_message', () => {
  it('forwards via universal-message-watcher and returns queued', async () => {
    const tools = await getTools({ transport: 'http' });
    seedSession('lead');
    seedSession('teammate', { agentId: 'claude-code' });
    setSharedTeams('lead', 'teammate', ['team-X']);
    const r = await tools.get('send_message').handler({
      session_id: 'teammate',
      text: 'work please',
      caller_session_id: 'lead',
    }, {});
    const parsed = parseResult(r);
    expect(parsed.isError).toBeFalsy();
    expect(parsed.data.queued).toBe(true);
    expect(parsed.data.teamId).toBe('team-X');
    expect(enqueuedMessages).toEqual([
      { teamId: 'team-X', fromSessionId: 'lead', toSessionId: 'teammate', body: 'work please', replyToMessageId: null },
    ]);
  });

  it('rejects target session not found', async () => {
    const tools = await getTools({ transport: 'http' });
    seedSession('lead');
    const r = await tools.get('send_message').handler({
      session_id: 'ghost',
      text: 'hi',
      caller_session_id: 'lead',
    }, {});
    const parsed = parseResult(r);
    expect(parsed.isError).toBe(true);
    expect(parsed.data.error).toMatch(/not found/);
  });

  it('rejects closed target session', async () => {
    const tools = await getTools({ transport: 'http' });
    seedSession('lead');
    seedSession('teammate', { lifecycle: 'closed' });
    const r = await tools.get('send_message').handler({
      session_id: 'teammate',
      text: 'hi',
      caller_session_id: 'lead',
    }, {});
    const parsed = parseResult(r);
    expect(parsed.isError).toBe(true);
    expect(parsed.data.error).toMatch(/is closed/);
  });

  it('rejects when caller and target share zero teams', async () => {
    const tools = await getTools({ transport: 'http' });
    seedSession('lead');
    seedSession('teammate', { agentId: 'claude-code' });
    // 不调 setSharedTeams → 默认 zero
    const r = await tools.get('send_message').handler({
      session_id: 'teammate',
      text: 'hi',
      caller_session_id: 'lead',
    }, {});
    const parsed = parseResult(r);
    expect(parsed.isError).toBe(true);
    expect(parsed.data.error).toMatch(/no-shared-team/);
  });

  it('rejects ambiguous-team when sharing >=2 teams without team_id', async () => {
    const tools = await getTools({ transport: 'http' });
    seedSession('lead');
    seedSession('teammate', { agentId: 'claude-code' });
    setSharedTeams('lead', 'teammate', ['team-X', 'team-Y']);
    const r = await tools.get('send_message').handler({
      session_id: 'teammate',
      text: 'hi',
      caller_session_id: 'lead',
    }, {});
    const parsed = parseResult(r);
    expect(parsed.isError).toBe(true);
    expect(parsed.data.error).toMatch(/ambiguous-team/);
  });
});

describe('agent-deck-mcp tools — shutdown_session', () => {
  it('rejects shutdown self', async () => {
    const tools = await getTools({ transport: 'http' });
    seedSession('lead');
    const r = await tools.get('shutdown_session').handler({
      session_id: 'lead', // 同 caller
      caller_session_id: 'lead',
    }, {});
    const parsed = parseResult(r);
    expect(parsed.isError).toBe(true);
    expect(parsed.data.error).toMatch(/cannot shutdown self/);
  });

  it('rejects nonexistent target', async () => {
    const tools = await getTools({ transport: 'http' });
    seedSession('lead');
    const r = await tools.get('shutdown_session').handler({
      session_id: 'ghost',
      caller_session_id: 'lead',
    }, {});
    const parsed = parseResult(r);
    expect(parsed.isError).toBe(true);
    expect(parsed.data.error).toMatch(/not found/);
  });

  it('idempotent on already-closed target', async () => {
    const tools = await getTools({ transport: 'http' });
    seedSession('lead');
    seedSession('teammate', { lifecycle: 'closed' });
    const r = await tools.get('shutdown_session').handler({
      session_id: 'teammate',
      caller_session_id: 'lead',
    }, {});
    const parsed = parseResult(r);
    expect(parsed.isError).toBeFalsy();
    expect(parsed.data.alreadyClosed).toBe(true);
    expect(closeCalls).toEqual([]); // 已 closed 不重复调
  });

  it('calls sessionManager.close on active target', async () => {
    const tools = await getTools({ transport: 'http' });
    seedSession('lead');
    seedSession('teammate', { lifecycle: 'active' });
    const r = await tools.get('shutdown_session').handler({
      session_id: 'teammate',
      caller_session_id: 'lead',
    }, {});
    const parsed = parseResult(r);
    expect(parsed.isError).toBeFalsy();
    expect(parsed.data.alreadyClosed).toBe(false);
    expect(closeCalls).toEqual(['teammate']);
  });
});

describe('agent-deck-mcp tools — list_sessions', () => {
  it('projects metadata only (no events / messages)', async () => {
    const tools = await getTools({ transport: 'http' });
    seedSession('lead', { spawnDepth: 0 });
    seedSession('teammate', { spawnedBy: 'lead', spawnDepth: 1 });
    // plan team-cohesion-fix-20260513 Phase A：teamName 走 universal team backend 投影 → mock 注入 membership
    mockMembershipsBySession.set('lead', [{ teamId: 'team-x' }]);
    mockMembershipsBySession.set('teammate', [{ teamId: 'team-x' }]);
    mockTeamsById.set('team-x', { name: 'team-x' });
    const r = await tools.get('list_sessions').handler({
      caller_session_id: 'lead',
      status_filter: 'active',
      limit: 50,
    }, {});
    const parsed = parseResult(r);
    expect(parsed.isError).toBeFalsy();
    expect(parsed.data.sessions).toHaveLength(2);
    const teammate = parsed.data.sessions.find((s: any) => s.sessionId === 'teammate');
    expect(teammate).toMatchObject({
      adapter: 'claude-code',
      cwd: '/repo',
      lifecycle: 'active',
      teamName: 'team-x',
      spawnedBy: 'lead',
      spawnDepth: 1,
    });
    // 不暴露 SessionRecord 内部字段（events / activity 等都不在投影）
    expect(teammate).not.toHaveProperty('activity');
    expect(teammate).not.toHaveProperty('source');
  });

  it('respects adapter_filter', async () => {
    const tools = await getTools({ transport: 'http' });
    seedSession('claude-1', { agentId: 'claude-code' });
    seedSession('codex-1', { agentId: 'codex-cli' });
    seedSession('caller', { agentId: 'claude-code' });
    const r = await tools.get('list_sessions').handler({
      caller_session_id: 'caller',
      status_filter: 'active',
      adapter_filter: 'codex-cli',
      limit: 50,
    }, {});
    const parsed = parseResult(r);
    expect(parsed.data.sessions).toHaveLength(1);
    expect(parsed.data.sessions[0].sessionId).toBe('codex-1');
  });

  it('respects spawned_by_filter (REVIEW_28 E 段)', async () => {
    const tools = await getTools({ transport: 'http' });
    seedSession('leadA');
    seedSession('leadB');
    seedSession('a-c1', { spawnedBy: 'leadA' });
    seedSession('a-c2', { spawnedBy: 'leadA' });
    seedSession('b-c1', { spawnedBy: 'leadB' });
    const r = await tools.get('list_sessions').handler({
      caller_session_id: 'leadA',
      status_filter: 'active',
      spawned_by_filter: 'leadA',
      limit: 50,
    }, {});
    const parsed = parseResult(r);
    expect(parsed.isError).toBeFalsy();
    expect(parsed.data.sessions).toHaveLength(2);
    expect(parsed.data.sessions.map((s: any) => s.sessionId).sort()).toEqual(['a-c1', 'a-c2']);
  });

  it('combines spawned_by_filter + adapter_filter (REVIEW_28 E 段)', async () => {
    const tools = await getTools({ transport: 'http' });
    seedSession('lead');
    seedSession('claude-child', { spawnedBy: 'lead', agentId: 'claude-code' });
    seedSession('codex-child', { spawnedBy: 'lead', agentId: 'codex-cli' });
    seedSession('orphan-claude', { spawnedBy: null, agentId: 'claude-code' });
    const r = await tools.get('list_sessions').handler({
      caller_session_id: 'lead',
      status_filter: 'active',
      spawned_by_filter: 'lead',
      adapter_filter: 'claude-code',
      limit: 50,
    }, {});
    const parsed = parseResult(r);
    expect(parsed.isError).toBeFalsy();
    expect(parsed.data.sessions).toHaveLength(1);
    expect(parsed.data.sessions[0].sessionId).toBe('claude-child');
  });
});

describe('agent-deck-mcp tools — get_session (REVIEW_28 F 段)', () => {
  it('returns same projection as list_sessions', async () => {
    const tools = await getTools({ transport: 'http' });
    seedSession('lead');
    seedSession('teammate', { spawnedBy: 'lead', spawnDepth: 1 });
    // plan team-cohesion-fix-20260513 Phase A：teamName 走 universal team backend 投影
    mockMembershipsBySession.set('teammate', [{ teamId: 'team-x' }]);
    mockTeamsById.set('team-x', { name: 'team-x' });
    const r = await tools.get('get_session').handler({
      caller_session_id: 'lead',
      session_id: 'teammate',
    }, {});
    const parsed = parseResult(r);
    expect(parsed.isError).toBeFalsy();
    expect(parsed.data).toMatchObject({
      sessionId: 'teammate',
      adapter: 'claude-code',
      cwd: '/repo',
      lifecycle: 'active',
      teamName: 'team-x',
      spawnedBy: 'lead',
      spawnDepth: 1,
    });
    expect(parsed.data).not.toHaveProperty('activity');
    expect(parsed.data).not.toHaveProperty('source');
  });

  it('returns isError when session does not exist', async () => {
    const tools = await getTools({ transport: 'http' });
    seedSession('lead');
    const r = await tools.get('get_session').handler({
      caller_session_id: 'lead',
      session_id: 'ghost',
    }, {});
    const parsed = parseResult(r);
    expect(parsed.isError).toBe(true);
    expect(parsed.data.error).toMatch(/session ghost not found/);
  });

  // D3 (CHANGELOG_76 / plan deep-review-flow-fix): projectSession 反查 universal team backend
  // 修「lead session teamName: null 不对称」bug。teammate 走老的 sessions.team_name 列已 OK；
  // lead 没 recordCreatedTeamName，必须从 members 反查。
  it('lead session teamName from universal team backend (not sessions.team_name)', async () => {
    const tools = await getTools({ transport: 'http' });
    // lead session 自身 sessionRecord.teamName = null（spawn_session handler addMember 但
    // 不调 recordCreatedTeamName），但 universal team backend members 表有它（active membership）
    seedSession('lead', { cwd: '/repo' });
    mockMembershipsBySession.set('lead', [{ teamId: 'team-review-team' }]);
    mockTeamsById.set('team-review-team', { name: 'review-team' });

    const r = await tools.get('get_session').handler({
      caller_session_id: 'lead',
      session_id: 'lead',
    }, {});
    const parsed = parseResult(r);
    expect(parsed.isError).toBeFalsy();
    // 反查命中 → 投影 teamName 来自 universal team backend
    expect(parsed.data.teamName).toBe('review-team');
  });

  it('falls back to empty teamName when no universal team membership (v014 后无 sessions.team_name 兜底)', async () => {
    const tools = await getTools({ transport: 'http' });
    // 不注入 mock memberships，模拟「session 不在 universal team backend members 表」
    // plan team-cohesion-fix-20260513 Phase A Step A9：v014 drop sessions.team_name 后老 fallback 已删，
    // teamName: null
    seedSession('legacy-session', { cwd: '/repo' });

    const r = await tools.get('get_session').handler({
      caller_session_id: 'legacy-session',
      session_id: 'legacy-session',
    }, {});
    const parsed = parseResult(r);
    expect(parsed.isError).toBeFalsy();
    // 反查空 → projectSession 投影 teamName: null（无老 sessions.team_name 兜底）
    expect(parsed.data.teamName).toBeNull();
  });
});

describe('agent-deck-mcp tools — wait_reply (plan team-cohesion-fix-20260513 Phase B 新语义)', () => {
  it('rejects unknown message_id', async () => {
    const tools = await getTools({ transport: 'http' });
    seedSession('lead');
    // 不注入 mockMessages → get(unknown-msg) 返 null
    const r = await tools.get('wait_reply').handler({
      message_id: 'ghost-msg',
      timeout_ms: 1000,
      caller_session_id: 'lead',
    }, {});
    const parsed = parseResult(r);
    expect(parsed.isError).toBe(true);
    expect(parsed.data.error).toMatch(/not found/);
  });

  it('returns reply immediately when reply already exists (race-safe)', async () => {
    const tools = await getTools({ transport: 'http' });
    seedSession('lead');
    seedSession('teammate');
    // 模拟原 msg + 已存在的 reply
    const original: AgentDeckMessage = {
      id: 'msg-1', teamId: 'team-x', fromSessionId: 'lead', toSessionId: 'teammate',
      body: 'q', status: 'delivered', statusReason: null,
      sentAt: 1000, deliveredAt: 1100, attemptCount: 1, lastAttemptAt: 1000, deliveringSince: null,
      replyToMessageId: null,
    };
    const reply: AgentDeckMessage = {
      id: 'msg-2', teamId: 'team-x', fromSessionId: 'teammate', toSessionId: 'lead',
      body: 'a', status: 'delivered', statusReason: null,
      sentAt: 2000, deliveredAt: 2100, attemptCount: 1, lastAttemptAt: 2000, deliveringSince: null,
      replyToMessageId: 'msg-1',
    };
    mockMessages.set('msg-1', original);
    mockReplies.set('msg-1', [reply]);

    const r = await tools.get('wait_reply').handler({
      message_id: 'msg-1',
      timeout_ms: 5000,
      caller_session_id: 'lead',
    }, {});
    const parsed = parseResult(r);
    expect(parsed.isError).toBeFalsy();
    expect(parsed.data.reply).toMatchObject({
      messageId: 'msg-2',
      text: 'a',
      sentAt: 2000,
      fromSessionId: 'teammate',
    });
    expect(parsed.data.timedOut).toBe(false);
    expect(parsed.data.nudgesSent).toBe(0);
  });

  it('returns timed_out=true with reply=null when no reply within timeout', async () => {
    const tools = await getTools({ transport: 'http' });
    seedSession('lead');
    seedSession('teammate');
    // 注入原 msg 但不注入 reply
    const original: AgentDeckMessage = {
      id: 'msg-3', teamId: 'team-x', fromSessionId: 'lead', toSessionId: 'teammate',
      body: 'q', status: 'delivered', statusReason: null,
      sentAt: 1000, deliveredAt: 1100, attemptCount: 1, lastAttemptAt: 1000, deliveringSince: null,
      replyToMessageId: null,
    };
    mockMessages.set('msg-3', original);

    const r = await tools.get('wait_reply').handler({
      message_id: 'msg-3',
      timeout_ms: 1000,  // 1s 必超时
      caller_session_id: 'lead',
    }, {});
    const parsed = parseResult(r);
    expect(parsed.isError).toBeFalsy();
    expect(parsed.data.reply).toBeNull();
    expect(parsed.data.timedOut).toBe(true);
    expect(parsed.data.nudgesSent).toBe(0);
  });

  // CHANGELOG_98 / R2 reviewer-{claude,codex} MED：Phase A2 nudge 死锁修引入
  // nudgeMessageIds 双查 + ok return 加 nudgeMessageIds 字段，但 R2 R1 fix 只加了实现
  // 没补回归测试。本 F2 补 3 case：(a) nudge 触发 → ok return.nudgeMessageIds 含 nudge id
  // (b) reply 给 originalId（findRepliesAcrossAllAnchors originalId 路径命中）
  // (c) reply 给 nudgeId（findRepliesAcrossAllAnchors nudgeIds 路径命中，B14 dormant +
  //     reviewer-codex MED2 实测核心场景：teammate 默认按 wire prefix 第一个 [msg ...]
  //     抓 messageId，watcher 给 nudge body 自动注入新 nudgeId prefix → teammate 默认
  //     reply nudgeId 而非 originalId → 旧实现 lead 永等不到，本 case 验证修复后命中）

  it('CHANGELOG_98: nudge 触发 → ok return.nudgeMessageIds 含 nudge id + nudgesSent=1', async () => {
    const tools = await getTools({ transport: 'http' });
    seedSession('lead');
    seedSession('teammate');
    const original: AgentDeckMessage = {
      id: 'orig-msg-A', teamId: 'team-y', fromSessionId: 'lead', toSessionId: 'teammate',
      body: 'q', status: 'delivered', statusReason: null,
      sentAt: 1000, deliveredAt: 1100, attemptCount: 1, lastAttemptAt: 1000, deliveringSince: null,
      replyToMessageId: null,
    };
    mockMessages.set('orig-msg-A', original);

    const r = await tools.get('wait_reply').handler({
      message_id: 'orig-msg-A',
      timeout_ms: 1500,
      nudge_text: 'are you there?',
      nudge_after_ms: 100, // 100ms 后 nudge 触发，剩 1.4s 等 timeout
      caller_session_id: 'lead',
    }, {});
    const parsed = parseResult(r);
    expect(parsed.isError).toBeFalsy();
    expect(parsed.data.reply).toBeNull();          // 没 reply 注入 → null
    expect(parsed.data.timedOut).toBe(true);       // 超时
    expect(parsed.data.nudgesSent).toBe(1);        // nudge 触发 1 次
    // F2 关键断言：nudgeMessageIds 含 nudge enqueue 返回的 id（mock 给 'msg-N' 形态）
    expect(parsed.data.nudgeMessageIds).toBeInstanceOf(Array);
    expect(parsed.data.nudgeMessageIds.length).toBe(1);
    expect(parsed.data.nudgeMessageIds[0]).toMatch(/^msg-/);
  });

  it('CHANGELOG_98: reply 给 originalId → findRepliesAcrossAllAnchors originalId 路径命中', async () => {
    const tools = await getTools({ transport: 'http' });
    seedSession('lead');
    seedSession('teammate');
    const original: AgentDeckMessage = {
      id: 'orig-msg-B', teamId: 'team-z', fromSessionId: 'lead', toSessionId: 'teammate',
      body: 'q', status: 'delivered', statusReason: null,
      sentAt: 1000, deliveredAt: 1100, attemptCount: 1, lastAttemptAt: 1000, deliveringSince: null,
      replyToMessageId: null,
    };
    mockMessages.set('orig-msg-B', original);

    // 200ms 后注入 reply 给 originalId + emit listener 触发 checkReply
    const reply: AgentDeckMessage = {
      id: 'reply-to-orig', teamId: 'team-z', fromSessionId: 'teammate', toSessionId: 'lead',
      body: 'a', status: 'delivered', statusReason: null,
      sentAt: 2000, deliveredAt: 2100, attemptCount: 1, lastAttemptAt: 2000, deliveringSince: null,
      replyToMessageId: 'orig-msg-B',
    };
    setTimeout(() => {
      mockReplies.set('orig-msg-B', [reply]);
      eventBus.emit('agent-deck-message-enqueued', {
        id: 'reply-to-orig',
        teamId: 'team-z',
        fromSessionId: 'teammate',
        toSessionId: 'lead',
      });
    }, 200);

    const r = await tools.get('wait_reply').handler({
      message_id: 'orig-msg-B',
      timeout_ms: 5000,
      nudge_text: 'are you there?',
      nudge_after_ms: 100, // 100ms nudge → 200ms 后 reply 来命中
      caller_session_id: 'lead',
    }, {});
    const parsed = parseResult(r);
    expect(parsed.isError).toBeFalsy();
    // 关键：reply 命中（走 originalId 路径，因为 mockReplies 的 key 是 originalId）
    expect(parsed.data.reply).toMatchObject({
      messageId: 'reply-to-orig',
      text: 'a',
      fromSessionId: 'teammate',
    });
    expect(parsed.data.timedOut).toBe(false);
    expect(parsed.data.nudgesSent).toBe(1);
    expect(parsed.data.nudgeMessageIds.length).toBe(1);
  });

  it('CHANGELOG_98: reply 给 nudgeId → findRepliesAcrossAllAnchors nudgeIds 路径命中（核心场景）', async () => {
    const tools = await getTools({ transport: 'http' });
    seedSession('lead');
    seedSession('teammate');
    const original: AgentDeckMessage = {
      id: 'orig-msg-C', teamId: 'team-w', fromSessionId: 'lead', toSessionId: 'teammate',
      body: 'q', status: 'delivered', statusReason: null,
      sentAt: 1000, deliveredAt: 1100, attemptCount: 1, lastAttemptAt: 1000, deliveringSince: null,
      replyToMessageId: null,
    };
    mockMessages.set('orig-msg-C', original);

    // 200ms 后注入 reply 但 reply_to_message_id 指向 nudge 的 id（'msg-1'，mock enqueue
    // 第一个 id）+ emit。**关键**：mockReplies 的 key 是 'msg-1'（nudge id）不是
    // originalId。旧实现 findRepliesByMessageId(originalId) 返回 [] → 永等不到；
    // 新实现 findRepliesAcrossAllAnchors([originalId, ...nudgeIds]) 命中 nudgeIds 路径。
    const reply: AgentDeckMessage = {
      id: 'reply-to-nudge', teamId: 'team-w', fromSessionId: 'teammate', toSessionId: 'lead',
      body: 'a (replied to nudge)', status: 'delivered', statusReason: null,
      sentAt: 2000, deliveredAt: 2100, attemptCount: 1, lastAttemptAt: 2000, deliveringSince: null,
      replyToMessageId: 'msg-1', // ← 关键：指向 nudgeId，不是 originalId
    };
    setTimeout(() => {
      // 注入到 mock 'msg-1' 路径（nudgeId）
      mockReplies.set('msg-1', [reply]);
      eventBus.emit('agent-deck-message-enqueued', {
        id: 'reply-to-nudge',
        teamId: 'team-w',
        fromSessionId: 'teammate',
        toSessionId: 'lead',
      });
    }, 200);

    const r = await tools.get('wait_reply').handler({
      message_id: 'orig-msg-C',
      timeout_ms: 5000,
      nudge_text: 'are you there?',
      nudge_after_ms: 100,
      caller_session_id: 'lead',
    }, {});
    const parsed = parseResult(r);
    expect(parsed.isError).toBeFalsy();
    // 关键：reply 命中走 nudgeIds 路径（旧实现这里 reply=null + timedOut=true）
    expect(parsed.data.reply).toMatchObject({
      messageId: 'reply-to-nudge',
      text: 'a (replied to nudge)',
      fromSessionId: 'teammate',
    });
    expect(parsed.data.timedOut).toBe(false);
    expect(parsed.data.nudgesSent).toBe(1);
    expect(parsed.data.nudgeMessageIds.length).toBe(1);
    expect(parsed.data.nudgeMessageIds[0]).toBe('msg-1');
  });
});

describe('agent-deck-mcp tools — check_reply (plan mcp-bug-and-feature-batch-20260513 Phase 1 Step 1.3+1.4)', () => {
  it('returns reply immediately when reply already exists (legitReply 方向校验通过)', async () => {
    const tools = await getTools({ transport: 'http' });
    seedSession('lead');
    seedSession('teammate');
    const original: AgentDeckMessage = {
      id: 'check-msg-1', teamId: 'team-x', fromSessionId: 'lead', toSessionId: 'teammate',
      body: 'q', status: 'delivered', statusReason: null,
      sentAt: 1000, deliveredAt: 1100, attemptCount: 1, lastAttemptAt: 1000, deliveringSince: null,
      replyToMessageId: null,
    };
    const reply: AgentDeckMessage = {
      id: 'check-msg-2', teamId: 'team-x', fromSessionId: 'teammate', toSessionId: 'lead',
      body: 'a', status: 'delivered', statusReason: null,
      sentAt: 2000, deliveredAt: 2100, attemptCount: 1, lastAttemptAt: 2000, deliveringSince: null,
      replyToMessageId: 'check-msg-1',
    };
    mockMessages.set('check-msg-1', original);
    mockReplies.set('check-msg-1', [reply]);

    const r = await tools.get('check_reply').handler({
      message_id: 'check-msg-1',
      caller_session_id: 'lead',
    }, {});
    const parsed = parseResult(r);
    expect(parsed.isError).toBeFalsy();
    expect(parsed.data.reply).toMatchObject({
      messageId: 'check-msg-2',
      text: 'a',
      sentAt: 2000,
      fromSessionId: 'teammate',
    });
    expect(parsed.data.timedOut).toBe(false);
  });

  it('returns reply: null when no reply exists (non-blocking, no listener / nudge / timeout)', async () => {
    const tools = await getTools({ transport: 'http' });
    seedSession('lead');
    seedSession('teammate');
    const original: AgentDeckMessage = {
      id: 'check-msg-3', teamId: 'team-x', fromSessionId: 'lead', toSessionId: 'teammate',
      body: 'q', status: 'delivered', statusReason: null,
      sentAt: 1000, deliveredAt: 1100, attemptCount: 1, lastAttemptAt: 1000, deliveringSince: null,
      replyToMessageId: null,
    };
    mockMessages.set('check-msg-3', original);
    // 不注入 reply

    const t0 = Date.now();
    const r = await tools.get('check_reply').handler({
      message_id: 'check-msg-3',
      caller_session_id: 'lead',
    }, {});
    const elapsed = Date.now() - t0;
    // check_reply 必须立即返回（不阻塞），整个调用 < 100ms
    expect(elapsed).toBeLessThan(100);

    const parsed = parseResult(r);
    expect(parsed.isError).toBeFalsy();
    expect(parsed.data.reply).toBeNull();
    expect(parsed.data.timedOut).toBe(false); // check_reply 永不 timedOut
  });

  it('rejects unknown message_id', async () => {
    const tools = await getTools({ transport: 'http' });
    seedSession('lead');
    const r = await tools.get('check_reply').handler({
      message_id: 'ghost-check-msg',
      caller_session_id: 'lead',
    }, {});
    const parsed = parseResult(r);
    expect(parsed.isError).toBe(true);
    expect(parsed.data.error).toMatch(/not found/);
  });
});
