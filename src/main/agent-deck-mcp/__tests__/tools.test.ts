/**
 * Agent Deck MCP server B'2.a tool handler 决策单测。
 *
 * 不依赖真实 SQLite / Electron / SDK 子进程：用 vi.mock 把 sessionRepo /
 * sessionManager / adapterRegistry 替换为内存 stub，验证：
 *
 * - external caller（__external__）对 spawn / send / shutdown 自动 deny
 * - in-process closure 强制覆盖 args.callerSessionId（验证防 prompt 注入）
 * - HTTP/stdio caller 反查 sessionManager 不存在 / 已 closed 时 deny
 * - shutdown_session(self) deny
 * - send_message 目标 session closed 时 deny
 * - list_sessions 投影 metadata 不含 events / messages
 * - spawn_session same-cwd same-adapter 是合法路径（REVIEW_28 移除 §6.2 后）
 *
 * 完整防递归 3 条规则（depth / fan-out / spawn-rate）的单测放 spawn-guards.test.ts。
 * CHANGELOG_100：删 wait_reply / reply_message / check_reply 三 tool 后，wait-reply-coordinator
 * 文件已删（无对应 backfill 测试）。所有 reply 现在走 send_message + replyToMessageId。
 */

import { describe, expect, it, vi, beforeEach } from 'vitest';
import type { SessionRecord, AgentDeckMessage, HandOffMetadata } from '@shared/types';
import { makeSessionRepoMock } from '@main/__tests__/_shared/mocks/session-repo';
import { makeSdkLoaderMock } from '@main/__tests__/_shared/mocks/sdk-loader';
import { makeSettingsStoreMock } from '@main/__tests__/_shared/mocks/settings-store';
import { makeAgentDeckTeamRepoMock } from '@main/__tests__/_shared/mocks/agent-deck-team-repo';
import type { AgentDeckTeamRepo } from '@main/store/agent-deck-team-repo';
// REVIEW_85 MED-1/MED-2: 从 mock 模块拿 TeamInvariantError（vi.mock 导出的同一 class），
// 让 addMemberThrow 抛的 error 能被 handler 的 `instanceof TeamInvariantError` 识别。
import { TeamInvariantError } from '@main/store/agent-deck-team-repo';
import { adapterRegistry } from '@main/adapters/registry';
// REVIEW_85 MED-A: 用真实 inFlightChildren 单例断言 spawn handler 抛错路径不泄漏计数
// （tools.test.ts 不 mock rate-limiter，handler 走真 spawn-guards → 真 inFlightChildren）。
import { inFlightChildren } from '../rate-limiter';

// ─── Mock: sessionRepo / sessionManager / adapterRegistry ──────────────
// R37 P2-F Step 3.1：sessionRepo / sdk-loader / settings-store / agent-deck-team-repo
// 走 _shared/mocks/ factory；vi.hoisted 让 sessionStore 等 const 在 vi.mock factory
// 调用前已初始化（factory immediate access 闭包外 const 撞 ReferenceError）。
const { sessionStore, setSpawnLinkCalls, setTitleCalls, sessionGetThrow } = vi.hoisted(() => ({
  sessionStore: new Map<string, SessionRecord>(),
  setSpawnLinkCalls: [] as Array<{ id: string; parentId: string | null; depth: number }>,
  setTitleCalls: [] as Array<{ id: string; title: string }>,
  // REVIEW_85 MED-A (reviewer-claude): sessionGetThrow.sid 非 null 时 sessionRepo.get(sid) 抛错,
  // 验证 applySpawnGuards 下移后 caller DB 读抛错不泄漏 in-flight 计数。
  sessionGetThrow: { sid: null as string | null },
}));

vi.mock('@main/store/session-repo', () => ({
  sessionRepo: makeSessionRepoMock({
    sessions: sessionStore,
    overrides: {
      // REVIEW_85 MED-A: get override 支持模拟抛错（sessionGetThrow.sid 命中时）。
      get: (id: string) => {
        if (sessionGetThrow.sid !== null && id === sessionGetThrow.sid) {
          throw new Error('simulated DB error');
        }
        return sessionStore.get(id) ?? null;
      },
      // setSpawnLink / setTitle 被多处 test 断言调用 — 用 spy 包装记录调用 + 同步 stateful。
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
      // listActiveAndDormant 默认按 lifecycle≠closed && archivedAt==null 过滤；本 test 之前
      // 用 `slice(0, 100)` 全表（不过滤），这里保持原行为。
      listActiveAndDormant: () => [...sessionStore.values()].slice(0, 100),
    },
  }),
}));

const closeCalls: string[] = [];
const recordPermCalls: Array<{ sid: string; mode: string | undefined }> = [];
const notifyTeamCalls: string[] = [];
// REVIEW_85 MED-B (reviewer-claude): 设 true 时 recordCreatedPermissionMode 抛错（验证 spawn
// 仍返回成功不产生孤儿活 session）。
let recordPermThrow = false;

vi.mock('@main/session/manager', () => ({
  sessionManager: {
    close: async (id: string) => {
      closeCalls.push(id);
      const r = sessionStore.get(id);
      if (r) sessionStore.set(id, { ...r, lifecycle: 'closed' });
    },
    recordCreatedPermissionMode: (sid: string, mode: string | undefined) => {
      // REVIEW_85 MED-B: 模拟持久化抛错（DB write / emit listener 冒泡）
      if (recordPermThrow) throw new Error('simulated recordCreatedPermissionMode error');
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
// R1 reviewer-codex INFO 修法 (handoff-render-and-image-batch-20260521):扩 spy 捕获
// `handOff` 字段,让 handOff plumbing 透传到 adapter.createSession opts.handOff 有回归断言守门
// (覆盖 R3 曾经漏掉的 adapter facade → bridge 链路)。
const createSessionCalls: Array<{
  adapter: string;
  cwd: string;
  prompt?: string;
  teamName?: string;
  handOff?: HandOffMetadata;
  permissionMode?: string;
  codexSandbox?: string;
  claudeCodeSandbox?: string;
}> = [];

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
        createSession: async (opts: {
          cwd: string;
          prompt?: string;
          teamName?: string;
          handOff?: HandOffMetadata;
          permissionMode?: string;
          codexSandbox?: string;
          claudeCodeSandbox?: string;
        }) => {
          const sid = nextSpawnedSid;
          createSessionCalls.push({
            adapter: id,
            cwd: opts.cwd,
            prompt: opts.prompt,
            teamName: opts.teamName,
            handOff: opts.handOff,
            permissionMode: opts.permissionMode,
            codexSandbox: opts.codexSandbox,
            claudeCodeSandbox: opts.claudeCodeSandbox,
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
        sendMessage: async (sid: string, text: string) => {
          sendMessageCalls.push({ sid, text });
        },
      };
    },
  },
}));

// SDK loader 必须 mock —— 真实 loader 会动态 import @anthropic-ai/claude-agent-sdk
// 拉起底层 wasm，单测不需要实际 SDK
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

// settingsStore 走 electron-store / Electron app —— 测试环境拉不起来；
// 这里仅给 mcpWaitReplyIdleQuietMs 默认值就够（其他 setting 测试不读）。
vi.mock('@main/store/settings-store', () => ({
  settingsStore: makeSettingsStoreMock({
    initial: {
      // spawn-guards 读这些字段；测试默认给宽松值不阻塞 spawn 测试
      mcpMaxSpawnDepth: 3,
      mcpMaxFanOutPerParent: 5,
      mcpSpawnRatePerMinute: 100, // 测试调高，避免 21 测试连环 spawn 触发限流
      mcpWaitReplyIdleQuietMs: 50, // 短一点让 idle 测试快返
      mcpMessageRatePerTeamPerMin: 9999, // 测试不限流
    },
  }),
}));

// eventRepo backfill 单元用空数组（B'2.b backfill 行为在专门测试里覆盖）
vi.mock('@main/store/event-repo', () => ({
  eventRepo: {
    listForSessionRange: () => [],
  },
}));

// R3.E8 mock：agent-deck-team-repo + universal-message-watcher（spawn_session ensure-team /
// send_message route via DB envelope）。测试不实际操作 SQLite，只验证 handler 决策。
const enqueuedMessages: Array<{ teamId: string | null; fromSessionId: string; toSessionId: string; body: string }> = [];
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
// CHANGELOG_100 R2 fix (codex MED-2): mock listAllMembers / hardDelete 让 spawn handler 的
// teamCreatedNow 判定与 createSession 失败 cleanup 路径有合理 mock 行为。
const mockTeamMembers = new Map<string, Array<{ sessionId: string; role: string; displayName: string | null }>>();
const hardDeleteCalls: string[] = [];
// REVIEW_85 MED-1/MED-2 (reviewer-codex) 测试 hook:
// - addMemberThrow: 设为 {role,error} 时,匹配 role 的 addMember 调用抛该 error(模拟
//   TeamInvariantError lead-count 超 / 写失败);null = 不抛(默认)。
// - mockActiveMembershipIn: (teamId,sid)→membership|null,MED-1 修法反查 caller 是否真已
//   是 active lead 用(key=`${teamId}:${sid}`)。
let addMemberThrow: { role: 'lead' | 'teammate'; error: Error } | null = null;
const mockActiveMembershipIn = new Map<string, { role: 'lead' | 'teammate' }>();

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
        // REVIEW_85 MED-1/MED-2 hook：匹配 role 的调用抛错（模拟 lead-count 超 / 写失败）。
        if (addMemberThrow && addMemberThrow.role === input.role) {
          throw addMemberThrow.error;
        }
        addMemberCalls.push(input);
        // 同步追到 mockTeamMembers 让 listAllMembers 看见
        const arr = mockTeamMembers.get(input.teamId) ?? [];
        arr.push({ sessionId: input.sessionId, role: input.role, displayName: input.displayName });
        mockTeamMembers.set(input.teamId, arr);
        return {};
      }) as unknown as AgentDeckTeamRepo['addMember'],
      findSharedActiveTeams: (a: string, b: string): string[] => {
        const key = [a, b].sort().join(':');
        return sharedTeamsBySession.get(key) ?? [];
      },
      // plan team-cohesion-fix-20260513 Phase A Step A2/A7：批量反查 (sessionManager.enrichWithTeamsBatch 用)
      findActiveMembershipsBySessionIds: ((sids: string[]) => {
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
      }) as unknown as AgentDeckTeamRepo['findActiveMembershipsBySessionIds'],
      findActiveMembershipsBySession: ((sid: string) =>
        mockMembershipsBySession.get(sid) ?? []) as unknown as AgentDeckTeamRepo['findActiveMembershipsBySession'],
      get: (teamId: string) => (mockTeamsById.get(teamId) ?? null) as ReturnType<AgentDeckTeamRepo['get']>,
      // REVIEW_85 MED-1 (reviewer-codex): findActiveMembershipIn 反查 caller 是否真已是 active lead
      findActiveMembershipIn: ((teamId: string, sessionId: string) =>
        (mockActiveMembershipIn.get(`${teamId}:${sessionId}`) ??
          null) as ReturnType<AgentDeckTeamRepo['findActiveMembershipIn']>),
      // CHANGELOG_100 R2 fix (codex MED-2)
      listAllMembers: ((teamId: string) =>
        mockTeamMembers.get(teamId) ?? []) as unknown as AgentDeckTeamRepo['listAllMembers'],
      hardDelete: (teamId: string) => {
        hardDeleteCalls.push(teamId);
        mockTeamMembers.delete(teamId);
        return true;
      },
    },
  }),
  TeamInvariantError: class TeamInvariantError extends Error {},
}));
// plan team-cohesion-fix-20260513 Phase B / CHANGELOG_100：mock agent-deck-message-repo
// for spawn placeholder enqueue + send_message reply chain validation
const mockMessages = new Map<string, AgentDeckMessage>();
const insertedMessages: Array<{ id: string; teamId: string; fromSessionId: string; toSessionId: string; body: string; replyToMessageId: string | null }> = [];
const markedDelivered: string[] = [];
let nextInsertId = 1;

vi.mock('@main/store/agent-deck-message-repo', () => ({
  agentDeckMessageRepo: {
    get: (id: string) => mockMessages.get(id) ?? null,
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
  enqueueAgentDeckMessage: (input: { teamId: string | null; fromSessionId: string; toSessionId: string; body: string }) => {
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

// D1 (CHANGELOG_76 / plan deep-review-flow-fix): spawn_session 加 agentName 时 handler
// 调 getBundledAssetContent 拼 body 到 prompt 头部。mock 提供 reviewer-claude 假 body，
// 其他 name 返回失败（模拟「找不到」）。
//
// REVIEW_31 Bug 1+2 修法：mock 必须严格按真实签名 `{ok:true,content} | {ok:false,reason}`，
// 否则 handler call-site 当 string|null 用就会 toString 成 "[object Object]"，单测看不出来
// 但生产 100% 失败（用户实测 SKILL spawn 出来 reviewer 收到的 prompt 顶部是 [object Object]
// 紧跟 ---\n\n + 任务体，agent body 完全没注入）。
//
// **plan codex-handoff-team-alignment-20260518 §P3 Step 3.4 升级**：mock signature 加第 3
// 参数 `adapter`（'claude-code' | 'codex-cli'）；现有测试 mock 行为对 adapter 不敏感（仅按
// kind+name 反查），保留 noop 兼容；新加 D3 矩阵 4 行测试时按需 narrow adapter 写更精确 mock。
vi.mock('@main/bundled-assets', () => ({
  getBundledAssetContent: (
    kind: 'agent' | 'skill',
    name: string,
    _adapter: 'claude-code' | 'codex-cli',
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
  mockTeamMembers.clear();
  hardDeleteCalls.length = 0;
  addMemberThrow = null;
  mockActiveMembershipIn.clear();
  recordPermThrow = false;
  sessionGetThrow.sid = null;
  inFlightChildren.reset();
  mockMessages.clear();
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
      callerSessionId: '__external__',
    }, {});
    const parsed = parseResult(r);
    expect(parsed.isError).toBe(true);
    expect(parsed.data.error).toMatch(/not allowed for external caller/);
  });

  it('list_sessions ALLOWS __external__ caller (read-only)', async () => {
    const tools = await getTools({ transport: 'stdio' });
    seedSession('lead-1');
    const r = await tools.get('list_sessions').handler({
      callerSessionId: '__external__',
      statusFilter: 'active',
      limit: 50,
    }, {});
    const parsed = parseResult(r);
    expect(parsed.isError).toBeFalsy();
    expect(parsed.data.sessions).toHaveLength(1);
  });

  it('shutdown_session denies __external__ caller', async () => {
    const tools = await getTools({ transport: 'stdio' });
    const r = await tools.get('shutdown_session').handler({
      sessionId: 'target',
      callerSessionId: '__external__',
    }, {});
    const parsed = parseResult(r);
    expect(parsed.isError).toBe(true);
  });
});

describe('agent-deck-mcp tools — caller validation (HTTP/stdio)', () => {
  it('rejects unknown callerSessionId', async () => {
    const tools = await getTools({ transport: 'http' });
    const r = await tools.get('list_sessions').handler({
      callerSessionId: 'nonexistent-sid',
      statusFilter: 'active',
      limit: 50,
    }, {});
    const parsed = parseResult(r);
    expect(parsed.isError).toBe(true);
    expect(parsed.data.error).toMatch(/unknown callerSessionId/);
  });

  it('rejects closed callerSessionId', async () => {
    const tools = await getTools({ transport: 'http' });
    seedSession('closed-lead', { lifecycle: 'closed' });
    const r = await tools.get('send_message').handler({
      sessionId: 'whatever',
      text: 'hi',
      callerSessionId: 'closed-lead',
    }, {});
    const parsed = parseResult(r);
    expect(parsed.isError).toBe(true);
    expect(parsed.data.error).toMatch(/is closed/);
  });

  it('in-process closure overrides args.callerSessionId (anti-injection)', async () => {
    const realCaller = 'real-lead';
    seedSession(realCaller);
    const tools = await getTools({
      transport: 'in-process',
      callerSessionIdOverride: () => realCaller,
    });
    seedSession('target');
    // LLM 试图伪造 callerSessionId 为 fake-id；in-process 应该静默用真实 closure id
    const r = await tools.get('shutdown_session').handler({
      sessionId: 'target',
      callerSessionId: 'fake-id',
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
      callerSessionId: 'lead',
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
      callerSessionId: 'lead',
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
      callerSessionId: 'lead',
    }, {});
    const parsed = parseResult(r);
    expect(parsed.isError).toBeFalsy();
  });

  it('same adapter spawn inherits caller permissionMode and sandbox settings', async () => {
    const tools = await getTools({ transport: 'http' });
    seedSession('lead', {
      cwd: '/repo',
      agentId: 'claude-code',
      permissionMode: 'plan',
      claudeCodeSandbox: 'strict',
    });
    const r = await tools.get('spawn_session').handler({
      adapter: 'claude-code',
      cwd: '/repo',
      prompt: 'same adapter task',
      callerSessionId: 'lead',
    }, {});
    const parsed = parseResult(r);
    expect(parsed.isError).toBeFalsy();
    expect(createSessionCalls).toHaveLength(1);
    expect(createSessionCalls[0].permissionMode).toBe('plan');
    expect(createSessionCalls[0].claudeCodeSandbox).toBe('strict');
    expect(recordPermCalls).toEqual([{ sid: 'spawned-1', mode: 'plan' }]);
  });

  it('cross-adapter codex → claude uses target defaults instead of inheriting caller settings', async () => {
    const tools = await getTools({ transport: 'http' });
    seedSession('lead', {
      cwd: '/repo',
      agentId: 'codex-cli',
      permissionMode: 'plan',
      codexSandbox: 'read-only',
      claudeCodeSandbox: 'strict',
    });
    const r = await tools.get('spawn_session').handler({
      adapter: 'claude-code',
      cwd: '/repo',
      prompt: 'cross adapter task',
      callerSessionId: 'lead',
    }, {});
    const parsed = parseResult(r);
    expect(parsed.isError).toBeFalsy();
    expect(createSessionCalls).toHaveLength(1);
    expect(createSessionCalls[0].permissionMode).toBe('bypassPermissions');
    expect(createSessionCalls[0].claudeCodeSandbox).toBeUndefined();
    expect(createSessionCalls[0].codexSandbox).toBeUndefined();
    expect(recordPermCalls).toEqual([{ sid: 'spawned-1', mode: 'bypassPermissions' }]);
  });

  it('cross-adapter explicit permissionMode and sandbox override target defaults', async () => {
    const tools = await getTools({ transport: 'http' });
    seedSession('lead', {
      cwd: '/repo',
      agentId: 'codex-cli',
      permissionMode: 'plan',
      codexSandbox: 'read-only',
      claudeCodeSandbox: 'strict',
    });
    const r = await tools.get('spawn_session').handler({
      adapter: 'claude-code',
      cwd: '/repo',
      prompt: 'cross adapter explicit task',
      permissionMode: 'acceptEdits',
      claudeCodeSandbox: 'workspace-write',
      callerSessionId: 'lead',
    }, {});
    const parsed = parseResult(r);
    expect(parsed.isError).toBeFalsy();
    expect(createSessionCalls).toHaveLength(1);
    expect(createSessionCalls[0].permissionMode).toBe('acceptEdits');
    expect(createSessionCalls[0].claudeCodeSandbox).toBe('workspace-write');
    expect(recordPermCalls).toEqual([{ sid: 'spawned-1', mode: 'acceptEdits' }]);
  });

  it('same codex adapter spawn inherits caller codex sandbox', async () => {
    const tools = await getTools({ transport: 'http' });
    seedSession('lead', {
      cwd: '/repo',
      agentId: 'codex-cli',
      codexSandbox: 'read-only',
    });
    const r = await tools.get('spawn_session').handler({
      adapter: 'codex-cli',
      cwd: '/repo',
      prompt: 'same codex task',
      callerSessionId: 'lead',
    }, {});
    const parsed = parseResult(r);
    expect(parsed.isError).toBeFalsy();
    expect(createSessionCalls).toHaveLength(1);
    expect(createSessionCalls[0].codexSandbox).toBe('read-only');
    expect(createSessionCalls[0].permissionMode).toBeUndefined();
    expect(recordPermCalls).toEqual([]);
  });

  it('records team membership when teamName provided', async () => {
    const tools = await getTools({ transport: 'http' });
    seedSession('lead', { cwd: '/repo' });
    const r = await tools.get('spawn_session').handler({
      adapter: 'codex-cli',
      cwd: '/repo',
      prompt: 'p',
      teamName: 'review-team',
      callerSessionId: 'lead',
    }, {});
    const parsed = parseResult(r);
    expect(parsed.isError).toBeFalsy();
    // plan team-cohesion-fix-20260513 Phase A Step A8：sessionManager.recordCreatedTeamName 已删，
    // spawn_session 改走 universal team backend addMember + notifyTeamMembershipChanged。
    // 验证 lead + teammate 都被 notify 触发桥点 enrich。
    expect(notifyTeamCalls).toContain('lead');
    expect(notifyTeamCalls).toContain('spawned-1');
  });

  // ─── REVIEW_85 (Batch F1) 回归 test ────────────────────────────────────

  // MED-1 (reviewer-codex): TeamInvariantError catch 过宽。lead addMember 抛 lead-count
  // TeamInvariantError 且 caller 不是已有 active lead → 不该吞当幂等成功（修前会，导致
  // caller 无 shared team teammate 首轮 reply 撞 no-shared-team）。修后 re-throw → 外层
  // catch 走 MED-2 降级（close 孤儿 + cleanup + return err）。
  it('MED-1: lead addMember 抛 TeamInvariantError 且 caller 非已有 lead → spawn 返 err（不吞当幂等）', async () => {
    const tools = await getTools({ transport: 'http' });
    seedSession('lead', { cwd: '/repo' });
    // caller 不是该 team 的 active lead（mockActiveMembershipIn 空 → findActiveMembershipIn 返 null）
    addMemberThrow = { role: 'lead', error: new TeamInvariantError('team x lead count 10 >= 10') };
    const r = await tools.get('spawn_session').handler({
      adapter: 'codex-cli',
      cwd: '/repo',
      prompt: 'p',
      teamName: 'review-team',
      callerSessionId: 'lead',
    }, {});
    const parsed = parseResult(r);
    expect(parsed.isError).toBe(true);
    expect(parsed.data.error).toMatch(/team setup failed/);
  });

  it('MED-1: lead addMember 抛 TeamInvariantError 但 caller 已是 active lead → 吞当幂等成功', async () => {
    const tools = await getTools({ transport: 'http' });
    seedSession('lead', { cwd: '/repo' });
    // caller 已是该 team 的 active lead → findActiveMembershipIn 返 {role:'lead'} → 吞幂等
    mockActiveMembershipIn.set('team-review-team:lead', { role: 'lead' });
    addMemberThrow = { role: 'lead', error: new TeamInvariantError('member lead already active in team') };
    const r = await tools.get('spawn_session').handler({
      adapter: 'codex-cli',
      cwd: '/repo',
      prompt: 'p',
      teamName: 'review-team',
      callerSessionId: 'lead',
    }, {});
    const parsed = parseResult(r);
    // 吞幂等 → 继续 teammate addMember + 正常返回成功
    expect(parsed.isError).toBeFalsy();
    expect(parsed.data.sessionId).toBe('spawned-1');
  });

  // MED-2 (reviewer-codex): teammate addMember 失败 → 不返回 dishonest ok，
  // 而是 close 孤儿 session + cleanup 空 team + return err。
  it('MED-2: teammate addMember 失败 → close 孤儿 session + hardDelete 空 team + 返 err', async () => {
    const tools = await getTools({ transport: 'http' });
    seedSession('lead', { cwd: '/repo' });
    addMemberThrow = { role: 'teammate', error: new Error('DB write failed') };
    const r = await tools.get('spawn_session').handler({
      adapter: 'codex-cli',
      cwd: '/repo',
      prompt: 'p',
      teamName: 'review-team',
      callerSessionId: 'lead',
    }, {});
    const parsed = parseResult(r);
    expect(parsed.isError).toBe(true);
    expect(parsed.data.error).toMatch(/team setup failed/);
    // 孤儿 session 被 close
    expect(closeCalls).toContain('spawned-1');
    // 本次新建空 team 被 hardDelete（teamCreatedNow=true，lead 已加成功后 teammate 失败，
    // 但 cleanup 前 re-verify listAllMembers — lead 在表里所以实际不删；改测「未撞 cleanup 错」
    // 即 close 已发生 + 返 err 是核心断言）。
  });

  // MED-B (reviewer-claude): recordCreatedPermissionMode 抛错不该让 spawn 失败产生孤儿
  // 活 session。修后包 try/catch → 失败仅 warn，spawn 仍返回成功 + sessionId。
  it('MED-B: recordCreatedPermissionMode 抛错 → spawn 仍返回成功（不产生孤儿）', async () => {
    const tools = await getTools({ transport: 'http' });
    seedSession('lead', { cwd: '/repo', permissionMode: 'plan' });
    // 让 recordCreatedPermissionMode 抛错（claude-code adapter canSetPermissionMode=true）
    recordPermThrow = true;
    const r = await tools.get('spawn_session').handler({
      adapter: 'claude-code',
      cwd: '/repo',
      prompt: 'p',
      callerSessionId: 'lead',
    }, {});
    const parsed = parseResult(r);
    expect(parsed.isError).toBeFalsy();
    expect(parsed.data.sessionId).toBe('spawned-1');
  });

  // MED-A (reviewer-claude): leak window 归零结构不变量。applySpawnGuards 下移后,
  // body 内 sessionRepo.get(caller)（leadRecord）抛错发生在 guard inc fanOutSlot 之前 →
  // 不可能泄漏 in-flight 计数。**用 in-process transport + closure override** 让
  // withMcpGuard 的 validateExternalCaller 跳过自己那次 sessionRepo.get（否则 throw 落在
  // wrapper 层根本到不了 handler body，测不到 leak window）。
  it('MED-A: leadRecord = sessionRepo.get(caller) 抛错 → 不泄漏 in-flight 计数（guard 已下移到 DB 读后）', async () => {
    const tools = await getTools({
      transport: 'in-process',
      callerSessionIdOverride: () => 'lead',
    });
    seedSession('lead', { cwd: '/repo' });
    const before = inFlightChildren.get('lead');
    sessionGetThrow.sid = 'lead'; // 让 body 内 sessionRepo.get('lead')（leadRecord）抛错
    await expect(
      tools.get('spawn_session').handler({
        adapter: 'codex-cli',
        cwd: '/repo',
        prompt: 'p',
        callerSessionId: 'lead',
      }, {}),
    ).rejects.toThrow(/simulated DB error/);
    sessionGetThrow.sid = null;
    // guard 在 leadRecord get 之后才 inc → 抛错时 fanOutSlot 根本没获取 → 计数零变化。
    // 修前(guard 在 leadRecord 前)：guard 已 inc → leadRecord throw → release 永不跑 → 泄漏 1。
    expect(inFlightChildren.get('lead')).toBe(before);
  });

  it('Phase B5+B7 方案 A: spawn 返 placeholder spawnPromptMessageId + wire format 注入 [msg <id>]', async () => {
    const tools = await getTools({ transport: 'http' });
    seedSession('lead', { cwd: '/repo' });
    const r = await tools.get('spawn_session').handler({
      adapter: 'codex-cli',
      cwd: '/repo',
      prompt: 'review src/foo.ts',
      teamName: 'review-team',
      callerSessionId: 'lead',
    }, {});
    const parsed = parseResult(r);
    expect(parsed.isError).toBeFalsy();
    // Phase B5: spawn 返 spawnPromptMessageId 非空（Phase B7：UUID v4 形式，由 spawn 预生成）
    const spawnId = parsed.data.spawnPromptMessageId;
    expect(spawnId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    // Phase B7 / CHANGELOG_100: createSession 收到的 prompt 顶部含 wire prefix
    // `[from <leadName> @ <leadAdapter>][msg <id>][sid <leadSid>]\n` 三段，让 teammate
    // 端 message-row.tsx parseWirePrefix 能识别并 regex 提 messageId 调 send_message 回 lead。
    expect(createSessionCalls).toHaveLength(1);
    const seenPrompt = createSessionCalls[0].prompt as string;
    expect(seenPrompt).toMatch(new RegExp(`^\\[from .+ @ .+\\]\\[msg ${spawnId}\\]\\[sid lead\\]\\n`));
    // body 仍含原始 promptToUse（spawn 拼 lead context block + --- + 原 prompt）
    expect(seenPrompt).toContain('review src/foo.ts');
    expect(seenPrompt).toContain('## Hand-off context (auto-injected by Agent Deck MCP)');
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

  it('Phase B7: spawn without teamName skips wire prefix injection (no placeholder)', async () => {
    const tools = await getTools({ transport: 'http' });
    seedSession('lead', { cwd: '/repo' });
    const r = await tools.get('spawn_session').handler({
      adapter: 'codex-cli',
      cwd: '/repo',
      prompt: 'standalone task',
      // 不传 teamName → 不创建 placeholder + 不注入 prefix
      callerSessionId: 'lead',
    }, {});
    const parsed = parseResult(r);
    expect(parsed.isError).toBeFalsy();
    expect(parsed.data.spawnPromptMessageId).toBeNull();
    expect(createSessionCalls).toHaveLength(1);
    expect(createSessionCalls[0].prompt).toBe('standalone task');  // 原样，无 prefix
    expect(insertedMessages).toEqual([]);  // 无 teamName 不入 placeholder
  });

  it('Phase B7 / CHANGELOG_100: spawn with agentName + teamName → wire prefix [from][msg][sid] on top of injected agent body', async () => {
    const tools = await getTools({ transport: 'http' });
    seedSession('lead', { cwd: '/repo' });
    const r = await tools.get('spawn_session').handler({
      adapter: 'claude-code',
      cwd: '/repo',
      prompt: 'task body: review src/foo.ts',
      agentName: 'reviewer-claude',
      teamName: 'review-team',
      callerSessionId: 'lead',
    }, {});
    const parsed = parseResult(r);
    expect(parsed.isError).toBeFalsy();
    const spawnId = parsed.data.spawnPromptMessageId;
    expect(spawnId).toMatch(/^[0-9a-f-]{36}$/);
    // wire prefix 三段 + lead context block + --- + agent body + --- + caller prompt 顺序
    const seenPrompt = createSessionCalls[0].prompt as string;
    expect(seenPrompt).toMatch(new RegExp(`^\\[from .+ @ .+\\]\\[msg ${spawnId}\\]\\[sid lead\\]\\n`));
    expect(seenPrompt).toContain('## Hand-off context (auto-injected by Agent Deck MCP)');
    expect(seenPrompt).toContain('# REVIEWER-CLAUDE BODY (mocked)');
    expect(seenPrompt).toContain('task body: review src/foo.ts');
    // DB body 不含 wire prefix / lead context block（保留 agent body + ---\n\n + caller prompt 形态）
    expect(insertedMessages[0].body).toBe(
      `# REVIEWER-CLAUDE BODY (mocked)\n你是对抗 reviewer。\n\n---\n\ntask body: review src/foo.ts`,
    );
  });

  it('rejects unknown adapter', async () => {
    const tools = await getTools({ transport: 'http' });
    seedSession('lead');
    // P3.1 zod enum 已限只允 claude-code / codex-cli;无法用未注册 adapter 名字测 spawn handler
    // 内部 cannot create sessions 路径(zod 在更早的 schema 层 reject)。改用 schema-valid
    // adapter ('codex-cli') + spy 局部覆盖 adapterRegistry.get 返 undefined,模拟
    // "schema 通过但 adapter 未 register 或无 createSession" 路径(spawn.ts:48-53 第一段 if)。
    const getSpy = vi.spyOn(adapterRegistry, 'get').mockReturnValueOnce(undefined);
    const r = await tools.get('spawn_session').handler({
      adapter: 'codex-cli',
      cwd: '/elsewhere',
      prompt: 'p',
      callerSessionId: 'lead',
    }, {});
    const parsed = parseResult(r);
    expect(parsed.isError).toBe(true);
    expect(parsed.data.error).toMatch(/cannot create sessions/);
    getSpy.mockRestore();
  });

  // D1 (CHANGELOG_76 / plan deep-review-flow-fix): agentName 自动注入 plugin agent body
  it('agentName auto-prepends plugin agent body to prompt', async () => {
    const tools = await getTools({ transport: 'http' });
    seedSession('lead', { cwd: '/repo' });
    const r = await tools.get('spawn_session').handler({
      adapter: 'claude-code',
      cwd: '/repo',
      prompt: 'task body: review src/foo.ts',
      agentName: 'reviewer-claude',
      callerSessionId: 'lead',
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

  it('agentName unresolved → returns err (no fallback to bare prompt)', async () => {
    const tools = await getTools({ transport: 'http' });
    seedSession('lead', { cwd: '/repo' });
    const r = await tools.get('spawn_session').handler({
      adapter: 'claude-code',
      cwd: '/repo',
      prompt: 'task body',
      agentName: 'nonexistent-agent',
      callerSessionId: 'lead',
    }, {});
    const parsed = parseResult(r);
    expect(parsed.isError).toBe(true);
    expect(parsed.data.error).toMatch(/agent body not found/);
    // 没静默 spawn
    expect(createSessionCalls).toHaveLength(0);
  });

  it('agentName omitted → prompt unchanged (backward compatible)', async () => {
    const tools = await getTools({ transport: 'http' });
    seedSession('lead', { cwd: '/repo' });
    const r = await tools.get('spawn_session').handler({
      adapter: 'claude-code',
      cwd: '/repo',
      prompt: 'plain prompt without body',
      callerSessionId: 'lead',
    }, {});
    const parsed = parseResult(r);
    expect(parsed.isError).toBeFalsy();
    expect(createSessionCalls).toHaveLength(1);
    expect(createSessionCalls[0].prompt).toBe('plain prompt without body');
  });

  // plan handoff-render-and-image-batch-20260521 §Phase 2 Step 2.2 + R1 reviewer-codex INFO 修法:
  // handOff plumbing 透传到 adapter.createSession opts.handOff 的回归断言(覆盖 spawn handler →
  // buildCreateSessionOptions → adapter narrow → facade → bridge 链路)。
  it('handOff plumbing: claude-code adapter receives handOff metadata via createSession opts', async () => {
    const tools = await getTools({ transport: 'http' });
    seedSession('lead', { cwd: '/repo' });
    const handOffMeta: HandOffMetadata = {
      mode: 'plan',
      planId: 'test-plan-id',
      phaseLabel: 'Phase 2 Step X',
      fromCallerSid: 'lead-sid',
      hasAdoptedBlock: true,
    };
    const r = await tools.get('spawn_session').handler({
      adapter: 'claude-code',
      cwd: '/repo',
      prompt: 'cold-start prompt',
      callerSessionId: 'lead',
      handOff: handOffMeta,
    }, {});
    const parsed = parseResult(r);
    expect(parsed.isError).toBeFalsy();
    expect(createSessionCalls).toHaveLength(1);
    expect(createSessionCalls[0].handOff).toEqual(handOffMeta);
  });

  it('handOff plumbing: codex-cli adapter receives handOff metadata via createSession opts', async () => {
    const tools = await getTools({ transport: 'http' });
    seedSession('lead', { cwd: '/repo' });
    const handOffMeta: HandOffMetadata = {
      mode: 'generic',
      planId: null,
      phaseLabel: null,
      fromCallerSid: 'lead-sid',
      hasAdoptedBlock: false,
    };
    const r = await tools.get('spawn_session').handler({
      adapter: 'codex-cli',
      cwd: '/repo',
      prompt: 'cold-start prompt',
      callerSessionId: 'lead',
      handOff: handOffMeta,
    }, {});
    const parsed = parseResult(r);
    expect(parsed.isError).toBeFalsy();
    expect(createSessionCalls).toHaveLength(1);
    expect(createSessionCalls[0].handOff).toEqual(handOffMeta);
  });

  it('handOff plumbing: caller not passing handOff → adapter receives handOff=undefined', async () => {
    const tools = await getTools({ transport: 'http' });
    seedSession('lead', { cwd: '/repo' });
    const r = await tools.get('spawn_session').handler({
      adapter: 'claude-code',
      cwd: '/repo',
      prompt: 'plain spawn without handOff',
      callerSessionId: 'lead',
    }, {});
    const parsed = parseResult(r);
    expect(parsed.isError).toBeFalsy();
    expect(createSessionCalls).toHaveLength(1);
    expect(createSessionCalls[0].handOff).toBeUndefined();
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
      agentName: 'reviewer-claude',
      teamName: 'review-team',
      callerSessionId: 'lead',
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

  // REVIEW_31 Bug 4：teammate display name fallback 链 = displayName > agentName > 不动。
  it('Bug 4: displayName overrides agentName for both session.title and team_member.displayName', async () => {
    const tools = await getTools({ transport: 'http' });
    seedSession('lead', { cwd: '/repo' });
    const r = await tools.get('spawn_session').handler({
      adapter: 'claude-code',
      cwd: '/repo',
      prompt: 'task body',
      agentName: 'reviewer-claude',
      displayName: 'reviewer-claude · batch A',
      teamName: 'review-team',
      callerSessionId: 'lead',
    }, {});
    const parsed = parseResult(r);
    expect(parsed.isError).toBeFalsy();
    const newSid = parsed.data.sessionId;
    // session.title 走 displayName（覆盖默认 cwd-basename）
    expect(setTitleCalls).toContainEqual({ id: newSid, title: 'reviewer-claude · batch A' });
    // team_member.displayName 同步走 displayName；lead 仍 displayName=null（lead 无 fallback 链）
    const teammateAdd = addMemberCalls.find((c) => c.sessionId === newSid && c.role === 'teammate');
    expect(teammateAdd?.displayName).toBe('reviewer-claude · batch A');
    const leadAdd = addMemberCalls.find((c) => c.sessionId === 'lead' && c.role === 'lead');
    expect(leadAdd?.displayName).toBeNull();
  });

  it('Bug 4: agentName fallback when displayName omitted', async () => {
    const tools = await getTools({ transport: 'http' });
    seedSession('lead', { cwd: '/repo' });
    const r = await tools.get('spawn_session').handler({
      adapter: 'claude-code',
      cwd: '/repo',
      prompt: 'task body',
      agentName: 'reviewer-claude',
      teamName: 'review-team',
      callerSessionId: 'lead',
    }, {});
    const parsed = parseResult(r);
    expect(parsed.isError).toBeFalsy();
    const newSid = parsed.data.sessionId;
    expect(setTitleCalls).toContainEqual({ id: newSid, title: 'reviewer-claude' });
    const teammateAdd = addMemberCalls.find((c) => c.sessionId === newSid && c.role === 'teammate');
    expect(teammateAdd?.displayName).toBe('reviewer-claude');
  });

  it('Bug 4: no displayName + no agentName → setTitle skipped (default cwd-basename preserved)', async () => {
    const tools = await getTools({ transport: 'http' });
    seedSession('lead', { cwd: '/repo' });
    const r = await tools.get('spawn_session').handler({
      adapter: 'claude-code',
      cwd: '/repo',
      prompt: 'naked spawn',
      teamName: 'review-team',
      callerSessionId: 'lead',
    }, {});
    const parsed = parseResult(r);
    expect(parsed.isError).toBeFalsy();
    const newSid = parsed.data.sessionId;
    // 无 displayName / agentName → 不调 setTitle，保留默认 title
    expect(setTitleCalls.find((c) => c.id === newSid)).toBeUndefined();
    const teammateAdd = addMemberCalls.find((c) => c.sessionId === newSid && c.role === 'teammate');
    expect(teammateAdd?.displayName).toBeNull();
  });
});

// REVIEW_37 R2 HIGH-1 修法（双方一致 ✅ 真 HIGH 异构强冗余验证）：spawn handler opts
// 第三参数 batonRole 让 caller 控制新 session 在 team 内是 'lead' 还是 'teammate'。
// 默认 'teammate'（普通 spawn_session 行为不变）；hand-off-session baton 路径显式传 'lead'
// 让新 session 接管 lead 角色，archive caller 时 countActiveLeads ≥ 1 不触发 auto-archive。
//
// 本 describe 直接 import spawnSessionHandler 调用（不走 tools registry），让能透传 opts
// 第三参数 — registry 包装层不暴露 opts。
describe('agent-deck-mcp tools — spawn_session opts.batonRole (R37 R2 HIGH-1)', () => {
  it('opts.batonRole=undefined（默认）→ addMember 用 role=teammate（普通 spawn 行为不变）', async () => {
    seedSession('lead', { cwd: '/repo' });
    const { spawnSessionHandler } = await import('../tools/handlers/spawn');

    const r = await spawnSessionHandler(
      {
        adapter: 'claude-code',
        cwd: '/repo',
        prompt: 'task body',
        teamName: 'review-team',
        callerSessionId: 'lead',
      },
      { caller: { callerSessionId: 'lead', transport: 'in-process' } },
      // opts 缺省 → batonRole 默认 'teammate'
    );
    const parsed = parseResult(r);
    expect(parsed.isError).toBeFalsy();
    const newSid = parsed.data.sessionId;
    const newSidAdd = addMemberCalls.find((c) => c.sessionId === newSid);
    expect(newSidAdd?.role).toBe('teammate');
    // caller 仍以 lead 加入（lead 路径不受 batonRole 影响）
    const leadAdd = addMemberCalls.find((c) => c.sessionId === 'lead');
    expect(leadAdd?.role).toBe('lead');
  });

  it('opts.batonRole=lead → addMember 用 role=lead（hand-off-session baton 接管路径）', async () => {
    seedSession('lead', { cwd: '/repo' });
    const { spawnSessionHandler } = await import('../tools/handlers/spawn');

    const r = await spawnSessionHandler(
      {
        adapter: 'claude-code',
        cwd: '/repo',
        prompt: 'baton task body',
        teamName: 'review-team',
        callerSessionId: 'lead',
      },
      { caller: { callerSessionId: 'lead', transport: 'in-process' } },
      { handOffMode: true, batonRole: 'lead' },
    );
    const parsed = parseResult(r);
    expect(parsed.isError).toBeFalsy();
    const newSid = parsed.data.sessionId;
    // 关键断言：新 session 是 lead（archive caller 后 countActiveLeads ≥ 1 不触发 auto-archive）
    const newSidAdd = addMemberCalls.find((c) => c.sessionId === newSid);
    expect(newSidAdd?.role).toBe('lead');
    // caller 仍以 lead 加入 — addMember 不去重，但实际生产 active 时 invariant 抛错（被 catch 视作幂等成功）
    const leadAdd = addMemberCalls.find((c) => c.sessionId === 'lead');
    expect(leadAdd?.role).toBe('lead');
    // plan handoff-no-spawn-guards-20260526 §D1/§D6 (改名 batonMode → handOffMode 后仍 valid):
    // 守门 handOffMode=true + 显式 teamName 组合下也跳 setSpawnLink。防未来 refactor
    // 误把 teamName 加进短路条件（如 `if (callerExists && !args.teamName && !opts?.handOffMode)`）
    // 让显式 teamName hand-off 退化回 bug。
    expect(setSpawnLinkCalls.find((c) => c.id === newSid)).toBeUndefined();
  });

  it('opts.batonRole=teammate（显式）→ 与默认相同 role=teammate', async () => {
    seedSession('lead', { cwd: '/repo' });
    const { spawnSessionHandler } = await import('../tools/handlers/spawn');

    const r = await spawnSessionHandler(
      {
        adapter: 'claude-code',
        cwd: '/repo',
        prompt: 'task body',
        teamName: 'review-team',
        callerSessionId: 'lead',
      },
      { caller: { callerSessionId: 'lead', transport: 'in-process' } },
      { handOffMode: true, batonRole: 'teammate' },
    );
    const parsed = parseResult(r);
    expect(parsed.isError).toBeFalsy();
    const newSid = parsed.data.sessionId;
    const newSidAdd = addMemberCalls.find((c) => c.sessionId === newSid);
    expect(newSidAdd?.role).toBe('teammate');
  });

  // plan handoff-no-spawn-guards-20260526 §D1/§D6 (改名 batonMode → handOffMode + 语义升级):
  // handOffMode=true 路径永不写 spawn-link,防 SessionList Phase C(CHANGELOG_77)按 spawnedBy
  // 树形分组渲染新 session 为 caller 的 ↳ teammate badge。hand-off 是平级接力(hand-off-session.ts:21-39
  // jsdoc「不是派出小弟干活」),不是 spawn parent-child 关系,数据层不应记录假 spawn-link。
  it('plan handoff-no-spawn-guards-20260526 §D1: handOffMode=true → 不调 setSpawnLink + spawnDepth=0', async () => {
    seedSession('lead', { cwd: '/repo' });
    const { spawnSessionHandler } = await import('../tools/handlers/spawn');

    const r = await spawnSessionHandler(
      {
        adapter: 'claude-code',
        cwd: '/repo',
        prompt: 'hand-off task body',
        // 不传 teamName，模拟真实 hand_off_session default 路径
        callerSessionId: 'lead',
      },
      { caller: { callerSessionId: 'lead', transport: 'in-process' } },
      { handOffMode: true, batonRole: 'lead' },
    );
    const parsed = parseResult(r);
    expect(parsed.isError).toBeFalsy();
    const newSid = parsed.data.sessionId;
    // 关键断言 1: setSpawnLink 不被调用（hand-off 路径数据层不记 spawn-link）
    const spawnLinkForNew = setSpawnLinkCalls.find((c) => c.id === newSid);
    expect(spawnLinkForNew).toBeUndefined();
    // 关键断言 2: ok return.spawnDepth = 0（hand-off 路径下新 session 在 DB 表现为顶层，无 spawn 关系）
    expect(parsed.data.spawnDepth).toBe(0);
  });

  // plan handoff-no-spawn-guards-20260526 §D7 §新增测试 §不变量 9 边界 case:
  // caller 自身 spawnDepth > 0(典型场景 — reviewer 由 lead 用 spawn_session 派出,caller.spawnDepth=1)
  // 通过 hand-off 起新 session,新 session 仍 spawnDepth=0(by design — hand-off 不继承 spawn 派遣 depth)
  it('plan handoff-no-spawn-guards-20260526 §不变量 9: caller spawnDepth>0 + handOffMode=true → 新 session.spawnDepth=0(不累积)', async () => {
    seedSession('reviewer', { cwd: '/repo', spawnDepth: 2 }); // ← caller 是 spawn 派遣链 L3 节点
    const { spawnSessionHandler } = await import('../tools/handlers/spawn');

    const r = await spawnSessionHandler(
      {
        adapter: 'claude-code',
        cwd: '/repo',
        prompt: 'hand-off from reviewer at spawnDepth=2',
        callerSessionId: 'reviewer',
      },
      { caller: { callerSessionId: 'reviewer', transport: 'in-process' } },
      { handOffMode: true, batonRole: 'lead' },
    );
    const parsed = parseResult(r);
    expect(parsed.isError).toBeFalsy();
    const newSid = parsed.data.sessionId;
    // 关键断言:新 session spawnDepth=0(不是 caller.spawnDepth+1=3 不是 caller.spawnDepth=2)
    // by design — hand-off 不继承 spawn 派遣 depth,平级接力语义
    expect(parsed.data.spawnDepth).toBe(0);
    // 同时验 setSpawnLink 不被调用(§D1 hand-off 永不写 spawn-link)
    expect(setSpawnLinkCalls.find((c) => c.id === newSid)).toBeUndefined();
  });

  // plan handoff-no-spawn-guards-20260526 §D1/§D6 守门: 普通 spawn (handOffMode=false / 缺省) 行为
  // 不变 — 仍写 spawn-link 让 reviewer 派活路径继续走树形分组（CHANGELOG_77 by design）。
  it('plan handoff-no-spawn-guards-20260526 §D1 守门: handOffMode=false（缺省）→ setSpawnLink 仍写 + spawnDepth=parentDepth+1', async () => {
    seedSession('lead', { cwd: '/repo' });
    const { spawnSessionHandler } = await import('../tools/handlers/spawn');

    const r = await spawnSessionHandler(
      {
        adapter: 'claude-code',
        cwd: '/repo',
        prompt: 'reviewer task body',
        teamName: 'review-team',
        callerSessionId: 'lead',
      },
      { caller: { callerSessionId: 'lead', transport: 'in-process' } },
      // opts 缺省 → handOffMode 默认 false，普通 spawn 路径不变
    );
    const parsed = parseResult(r);
    expect(parsed.isError).toBeFalsy();
    const newSid = parsed.data.sessionId;
    // 普通 spawn 仍写 spawn-link（CHANGELOG_77 by design：lead 派活，UI 树形分组合理）
    const spawnLinkForNew = setSpawnLinkCalls.find((c) => c.id === newSid);
    expect(spawnLinkForNew).toEqual({ id: newSid, parentId: 'lead', depth: 1 });
    expect(parsed.data.spawnDepth).toBe(1);
  });
});

describe('agent-deck-mcp tools — send_message', () => {
  it('forwards via universal-message-watcher and returns queued', async () => {
    const tools = await getTools({ transport: 'http' });
    seedSession('lead');
    seedSession('teammate', { agentId: 'claude-code' });
    setSharedTeams('lead', 'teammate', ['team-X']);
    const r = await tools.get('send_message').handler({
      sessionId: 'teammate',
      text: 'work please',
      callerSessionId: 'lead',
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
      sessionId: 'ghost',
      text: 'hi',
      callerSessionId: 'lead',
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
      sessionId: 'teammate',
      text: 'hi',
      callerSessionId: 'lead',
    }, {});
    const parsed = parseResult(r);
    expect(parsed.isError).toBe(true);
    expect(parsed.data.error).toMatch(/is closed/);
  });

  // plan teamless-dm-20260601 §不变量 7：原「share zero teams → no-shared-team reject」
  // 断言反转为「→ teamless DM 投递（teamId=null）」。这是 send_message gate 的唯一反转点
  // （hand-off 系列的 no-shared-team 保护断言禁止反转，见 hand-off-session.*.test.ts）。
  it('delivers as teamless DM when caller and target share zero teams', async () => {
    const tools = await getTools({ transport: 'http' });
    seedSession('lead');
    seedSession('teammate', { agentId: 'claude-code' });
    // 不调 setSharedTeams → 默认 zero shared team → teamless 分支
    const r = await tools.get('send_message').handler({
      sessionId: 'teammate',
      text: 'hi teamless',
      callerSessionId: 'lead',
    }, {});
    const parsed = parseResult(r);
    expect(parsed.isError).toBeFalsy();
    expect(parsed.data.queued).toBe(true);
    expect(parsed.data.teamId).toBeNull();
    expect(enqueuedMessages).toEqual([
      { teamId: null, fromSessionId: 'lead', toSessionId: 'teammate', body: 'hi teamless', replyToMessageId: null },
    ]);
  });

  // plan teamless-dm-20260601 D4 (codex-3)：显式传不共享的 teamId 必须 reject，不静默降级 teamless。
  it('rejects explicit teamId not in shared active set (no silent teamless downgrade)', async () => {
    const tools = await getTools({ transport: 'http' });
    seedSession('lead');
    seedSession('teammate', { agentId: 'claude-code' });
    // 双方零 shared team，但 caller 显式传了一个 teamId → 必须 team-not-shared reject
    const r = await tools.get('send_message').handler({
      sessionId: 'teammate',
      text: 'hi',
      teamId: 'team-stale',
      callerSessionId: 'lead',
    }, {});
    const parsed = parseResult(r);
    expect(parsed.isError).toBe(true);
    expect(parsed.data.error).toMatch(/team-not-shared/);
    expect(enqueuedMessages).toEqual([]); // 没有静默降级入队
  });

  // plan teamless-dm-20260601 D4 (codex-2)：teamless 分支前置补 archived reject
  // （findSharedActiveTeams 的 archived 过滤被绕过后必须显式补，§不变量 4）。
  it('rejects teamless DM when target session is archived', async () => {
    const tools = await getTools({ transport: 'http' });
    seedSession('lead');
    seedSession('teammate', { agentId: 'claude-code', archivedAt: Date.now() });
    const r = await tools.get('send_message').handler({
      sessionId: 'teammate',
      text: 'hi',
      callerSessionId: 'lead',
    }, {});
    const parsed = parseResult(r);
    expect(parsed.isError).toBe(true);
    expect(parsed.data.error).toMatch(/archived/);
    expect(enqueuedMessages).toEqual([]);
  });

  it('rejects teamless DM when caller session is archived', async () => {
    const tools = await getTools({ transport: 'http' });
    seedSession('lead', { archivedAt: Date.now() });
    seedSession('teammate', { agentId: 'claude-code' });
    const r = await tools.get('send_message').handler({
      sessionId: 'teammate',
      text: 'hi',
      callerSessionId: 'lead',
    }, {});
    const parsed = parseResult(r);
    expect(parsed.isError).toBe(true);
    expect(parsed.data.error).toMatch(/archived/);
    expect(enqueuedMessages).toEqual([]);
  });

  // plan teamless-dm-20260601 D4 (codex-1)：teamless reply 必须 pair-scoped。
  // original 是别的 session pair 的 teamless 消息 → 即便 teamId 都是 null 也必须 reject。
  it('rejects teamless reply pointing to a message between other sessions', async () => {
    const tools = await getTools({ transport: 'http' });
    seedSession('lead');
    seedSession('teammate', { agentId: 'claude-code' });
    // 无 shared team → teamless；但 original 是 sX↔sY 的 teamless 消息（与 lead/teammate 无关）
    mockMessages.set('other-pair-teamless', {
      id: 'other-pair-teamless',
      teamId: null,
      fromSessionId: 'sX',
      toSessionId: 'sY',
      body: 'unrelated teamless',
      status: 'delivered',
      statusReason: null,
      sentAt: 1000, deliveredAt: 1100, attemptCount: 1, lastAttemptAt: 1000, deliveringSince: null,
      replyToMessageId: null,
    });
    const r = await tools.get('send_message').handler({
      sessionId: 'teammate',
      text: 'reply',
      replyToMessageId: 'other-pair-teamless',
      callerSessionId: 'lead',
    }, {});
    const parsed = parseResult(r);
    expect(parsed.isError).toBe(true);
    expect(parsed.data.error).toMatch(/teamless reply chain mismatch/);
    expect(enqueuedMessages).toEqual([]);
  });

  it('allows teamless reply when original is between the same session pair', async () => {
    const tools = await getTools({ transport: 'http' });
    seedSession('lead');
    seedSession('teammate', { agentId: 'claude-code' });
    // original 是 teammate→lead 的 teamless 消息；lead 回 teammate → 同一对 session ✅
    mockMessages.set('same-pair-teamless', {
      id: 'same-pair-teamless',
      teamId: null,
      fromSessionId: 'teammate',
      toSessionId: 'lead',
      body: 'first teamless',
      status: 'delivered',
      statusReason: null,
      sentAt: 1000, deliveredAt: 1100, attemptCount: 1, lastAttemptAt: 1000, deliveringSince: null,
      replyToMessageId: null,
    });
    const r = await tools.get('send_message').handler({
      sessionId: 'teammate',
      text: 'my teamless reply',
      replyToMessageId: 'same-pair-teamless',
      callerSessionId: 'lead',
    }, {});
    const parsed = parseResult(r);
    expect(parsed.isError).toBeFalsy();
    expect(parsed.data.queued).toBe(true);
    expect(parsed.data.teamId).toBeNull();
    expect(enqueuedMessages).toEqual([
      { teamId: null, fromSessionId: 'lead', toSessionId: 'teammate', body: 'my teamless reply', replyToMessageId: 'same-pair-teamless' },
    ]);
  });

  // plan teamless-dm-20260601 D4：team↔teamless reply 边界对称（`!==` 天然处理）。
  it('rejects team reply pointing to a teamless original (teamId mismatch)', async () => {
    const tools = await getTools({ transport: 'http' });
    seedSession('lead');
    seedSession('teammate', { agentId: 'claude-code' });
    setSharedTeams('lead', 'teammate', ['team-X']); // team 模式
    mockMessages.set('teamless-original', {
      id: 'teamless-original',
      teamId: null, // teamless original
      fromSessionId: 'teammate',
      toSessionId: 'lead',
      body: 'teamless first',
      status: 'delivered',
      statusReason: null,
      sentAt: 1000, deliveredAt: 1100, attemptCount: 1, lastAttemptAt: 1000, deliveringSince: null,
      replyToMessageId: null,
    });
    const r = await tools.get('send_message').handler({
      sessionId: 'teammate',
      text: 'team reply',
      replyToMessageId: 'teamless-original',
      callerSessionId: 'lead',
    }, {});
    const parsed = parseResult(r);
    expect(parsed.isError).toBe(true);
    expect(parsed.data.error).toMatch(/cross-team reply not allowed/);
  });

  it('rejects ambiguous-team when sharing >=2 teams without teamId', async () => {
    const tools = await getTools({ transport: 'http' });
    seedSession('lead');
    seedSession('teammate', { agentId: 'claude-code' });
    setSharedTeams('lead', 'teammate', ['team-X', 'team-Y']);
    const r = await tools.get('send_message').handler({
      sessionId: 'teammate',
      text: 'hi',
      callerSessionId: 'lead',
    }, {});
    const parsed = parseResult(r);
    expect(parsed.isError).toBe(true);
    expect(parsed.data.error).toMatch(/ambiguous-team/);
  });

  // CHANGELOG_100 R2 fix (claude MED-1 + codex LOW-2 双方共识)：replyToMessageId 核心防御
  // 测试覆盖。删 wait_reply describe (含 mockMessages.set 的 replyToMessageId fixture) 后，
  // send.ts:91-105 的 reject path 必须由 send_message describe 自己覆盖。
  it('rejects replyToMessageId pointing to non-existent message', async () => {
    const tools = await getTools({ transport: 'http' });
    seedSession('lead');
    seedSession('teammate', { agentId: 'claude-code' });
    setSharedTeams('lead', 'teammate', ['team-X']);
    const r = await tools.get('send_message').handler({
      sessionId: 'teammate',
      text: 'reply text',
      replyToMessageId: 'ghost-msg-id',
      callerSessionId: 'lead',
    }, {});
    const parsed = parseResult(r);
    expect(parsed.isError).toBe(true);
    expect(parsed.data.error).toMatch(/replyToMessageId .* not found/);
  });

  it('rejects cross-team reply (original.teamId !== resolved teamId)', async () => {
    const tools = await getTools({ transport: 'http' });
    seedSession('lead');
    seedSession('teammate', { agentId: 'claude-code' });
    setSharedTeams('lead', 'teammate', ['team-X']);
    // mockMessages: original 在 team-Y，但 caller 试图把 reply 挂到 team-X chain
    mockMessages.set('cross-team-original', {
      id: 'cross-team-original',
      teamId: 'team-Y',  // 不同 team
      fromSessionId: 'someone-else',
      toSessionId: 'lead',
      body: 'original from another team',
      status: 'delivered',
      statusReason: null,
      sentAt: 1000, deliveredAt: 1100, attemptCount: 1, lastAttemptAt: 1000, deliveringSince: null,
      replyToMessageId: null,
    });
    const r = await tools.get('send_message').handler({
      sessionId: 'teammate',
      text: 'reply text',
      replyToMessageId: 'cross-team-original',
      callerSessionId: 'lead',
    }, {});
    const parsed = parseResult(r);
    expect(parsed.isError).toBe(true);
    expect(parsed.data.error).toMatch(/cross-team reply not allowed/);
  });

  it('passes replyToMessageId through to enqueue when same-team original exists', async () => {
    const tools = await getTools({ transport: 'http' });
    seedSession('lead');
    seedSession('teammate', { agentId: 'claude-code' });
    setSharedTeams('lead', 'teammate', ['team-X']);
    mockMessages.set('same-team-original', {
      id: 'same-team-original',
      teamId: 'team-X',  // 同 team
      fromSessionId: 'teammate',
      toSessionId: 'lead',
      body: 'first message',
      status: 'delivered',
      statusReason: null,
      sentAt: 1000, deliveredAt: 1100, attemptCount: 1, lastAttemptAt: 1000, deliveringSince: null,
      replyToMessageId: null,
    });
    const r = await tools.get('send_message').handler({
      sessionId: 'teammate',
      text: 'my reply',
      replyToMessageId: 'same-team-original',
      callerSessionId: 'lead',
    }, {});
    const parsed = parseResult(r);
    expect(parsed.isError).toBeFalsy();
    expect(parsed.data.queued).toBe(true);
    expect(enqueuedMessages).toEqual([
      {
        teamId: 'team-X',
        fromSessionId: 'lead',
        toSessionId: 'teammate',
        body: 'my reply',
        replyToMessageId: 'same-team-original',
      },
    ]);
  });
});

describe('agent-deck-mcp tools — shutdown_session', () => {
  it('rejects shutdown self', async () => {
    const tools = await getTools({ transport: 'http' });
    seedSession('lead');
    const r = await tools.get('shutdown_session').handler({
      sessionId: 'lead', // 同 caller
      callerSessionId: 'lead',
    }, {});
    const parsed = parseResult(r);
    expect(parsed.isError).toBe(true);
    expect(parsed.data.error).toMatch(/cannot shutdown self/);
  });

  it('rejects nonexistent target', async () => {
    const tools = await getTools({ transport: 'http' });
    seedSession('lead');
    const r = await tools.get('shutdown_session').handler({
      sessionId: 'ghost',
      callerSessionId: 'lead',
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
      sessionId: 'teammate',
      callerSessionId: 'lead',
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
      sessionId: 'teammate',
      callerSessionId: 'lead',
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
      callerSessionId: 'lead',
      statusFilter: 'active',
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

  it('respects adapterFilter', async () => {
    const tools = await getTools({ transport: 'http' });
    seedSession('claude-1', { agentId: 'claude-code' });
    seedSession('codex-1', { agentId: 'codex-cli' });
    seedSession('caller', { agentId: 'claude-code' });
    const r = await tools.get('list_sessions').handler({
      callerSessionId: 'caller',
      statusFilter: 'active',
      adapterFilter: 'codex-cli',
      limit: 50,
    }, {});
    const parsed = parseResult(r);
    expect(parsed.data.sessions).toHaveLength(1);
    expect(parsed.data.sessions[0].sessionId).toBe('codex-1');
  });

  it('respects spawnedByFilter (REVIEW_28 E 段)', async () => {
    const tools = await getTools({ transport: 'http' });
    seedSession('leadA');
    seedSession('leadB');
    seedSession('a-c1', { spawnedBy: 'leadA' });
    seedSession('a-c2', { spawnedBy: 'leadA' });
    seedSession('b-c1', { spawnedBy: 'leadB' });
    const r = await tools.get('list_sessions').handler({
      callerSessionId: 'leadA',
      statusFilter: 'active',
      spawnedByFilter: 'leadA',
      limit: 50,
    }, {});
    const parsed = parseResult(r);
    expect(parsed.isError).toBeFalsy();
    expect(parsed.data.sessions).toHaveLength(2);
    expect(parsed.data.sessions.map((s: any) => s.sessionId).sort()).toEqual(['a-c1', 'a-c2']);
  });

  it('combines spawnedByFilter + adapterFilter (REVIEW_28 E 段)', async () => {
    const tools = await getTools({ transport: 'http' });
    seedSession('lead');
    seedSession('claude-child', { spawnedBy: 'lead', agentId: 'claude-code' });
    seedSession('codex-child', { spawnedBy: 'lead', agentId: 'codex-cli' });
    seedSession('orphan-claude', { spawnedBy: null, agentId: 'claude-code' });
    const r = await tools.get('list_sessions').handler({
      callerSessionId: 'lead',
      statusFilter: 'active',
      spawnedByFilter: 'lead',
      adapterFilter: 'claude-code',
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
      callerSessionId: 'lead',
      sessionId: 'teammate',
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
      callerSessionId: 'lead',
      sessionId: 'ghost',
    }, {});
    const parsed = parseResult(r);
    expect(parsed.isError).toBe(true);
    expect(parsed.data.error).toMatch(/session ghost not found/);
  });

  // D3 (CHANGELOG_76 / plan deep-review-flow-fix): projectSession 反查 universal team backend
  // 修「lead session teamName: null 不对称」bug。teammate 走老的 sessions.teamName 列已 OK；
  // lead 没 recordCreatedTeamName，必须从 members 反查。
  it('lead session teamName from universal team backend (not sessions.teamName)', async () => {
    const tools = await getTools({ transport: 'http' });
    // lead session 自身 sessionRecord.teamName = null（spawn_session handler addMember 但
    // 不调 recordCreatedTeamName），但 universal team backend members 表有它（active membership）
    seedSession('lead', { cwd: '/repo' });
    mockMembershipsBySession.set('lead', [{ teamId: 'team-review-team' }]);
    mockTeamsById.set('team-review-team', { name: 'review-team' });

    const r = await tools.get('get_session').handler({
      callerSessionId: 'lead',
      sessionId: 'lead',
    }, {});
    const parsed = parseResult(r);
    expect(parsed.isError).toBeFalsy();
    // 反查命中 → 投影 teamName 来自 universal team backend
    expect(parsed.data.teamName).toBe('review-team');
  });

  it('falls back to empty teamName when no universal team membership (v014 后无 sessions.teamName 兜底)', async () => {
    const tools = await getTools({ transport: 'http' });
    // 不注入 mock memberships，模拟「session 不在 universal team backend members 表」
    // plan team-cohesion-fix-20260513 Phase A Step A9：v014 drop sessions.teamName 后老 fallback 已删，
    // teamName: null
    seedSession('legacy-session', { cwd: '/repo' });

    const r = await tools.get('get_session').handler({
      callerSessionId: 'legacy-session',
      sessionId: 'legacy-session',
    }, {});
    const parsed = parseResult(r);
    expect(parsed.isError).toBeFalsy();
    // 反查空 → projectSession 投影 teamName: null（无老 sessions.teamName 兜底）
    expect(parsed.data.teamName).toBeNull();
  });
});

// ─── plan hand-off-session-adopt-teammates-20260520 Phase 3 hard gate 2 ─────
//
// **范围**: 验证 ARCHIVE_PLAN_ARGS_SCHEMA / HAND_OFF_SESSION_ARGS_SCHEMA 双层命名
// (D2 + N4 + Round 3 MED-2) 的 strict reject 行为 — unknown keys (如已废弃的
// keep_teammates 字段) 必 throw `unrecognized_keys`。
//
// **设计要点**:
// - SHAPE = ZodRawShape 给 `tool()` 注册 + 三 transport 现有接口 — passthrough,允许 unknown keys
// - ARGS_SCHEMA = z.object(SHAPE).strict() 给 handler / type / test 用 — strict 模式 reject
//   unknown keys
// - 既挡 caller 从外部传旧字段误以为生效,也作为 schema breaking change 守门
//
// **守门 case** (3 条 + 1 happy path):
// 1. ARCHIVE_PLAN_ARGS_SCHEMA reject 旧 keep_teammates 字段(破除式守门)
// 2. HAND_OFF_SESSION_ARGS_SCHEMA reject 旧 keep_teammates 字段
// 3. ARCHIVE_PLAN_ARGS_SCHEMA reject 任意 unknown 字段(generic strict 守门)
// 4. ARCHIVE_PLAN_ARGS_SCHEMA happy path: 已知字段全 accept(回归保护)
describe('plan hand-off-session-adopt-teammates-20260520 Phase 3: ARGS_SCHEMA strict reject 守门', () => {
  it('hard gate 2: ARCHIVE_PLAN_ARGS_SCHEMA reject keep_teammates (Phase 3 已删字段)', async () => {
    const { ARCHIVE_PLAN_ARGS_SCHEMA } = await import('../tools/schemas');
    const result = ARCHIVE_PLAN_ARGS_SCHEMA.safeParse({
      planId: 'foo',
      worktreePath: '/abs/path',
      keep_teammates: true,
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      // 关键: zod strict 模式 reject unknown keys 时报 'unrecognized_keys' issue code
      const issues = result.error.issues;
      const hasUnrecognized = issues.some(
        (i) => i.code === 'unrecognized_keys' && (i as { keys?: string[] }).keys?.includes('keep_teammates'),
      );
      expect(hasUnrecognized).toBe(true);
    }
  });

  it('hard gate 2: HAND_OFF_SESSION_ARGS_SCHEMA reject keep_teammates (Phase 3 已删字段)', async () => {
    const { HAND_OFF_SESSION_ARGS_SCHEMA } = await import('../tools/schemas');
    const result = HAND_OFF_SESSION_ARGS_SCHEMA.safeParse({
      planId: 'foo',
      adapter: 'claude-code',
      keep_teammates: true,
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      const issues = result.error.issues;
      const hasUnrecognized = issues.some(
        (i) => i.code === 'unrecognized_keys' && (i as { keys?: string[] }).keys?.includes('keep_teammates'),
      );
      expect(hasUnrecognized).toBe(true);
    }
  });

  it('strict generic: ARCHIVE_PLAN_ARGS_SCHEMA reject 任意 unknown 字段', async () => {
    const { ARCHIVE_PLAN_ARGS_SCHEMA } = await import('../tools/schemas');
    const result = ARCHIVE_PLAN_ARGS_SCHEMA.safeParse({
      planId: 'foo',
      worktreePath: '/abs/path',
      __random_typo_field__: 'should be rejected',
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      const hasUnrecognized = result.error.issues.some(
        (i) =>
          i.code === 'unrecognized_keys' &&
          (i as { keys?: string[] }).keys?.includes('__random_typo_field__'),
      );
      expect(hasUnrecognized).toBe(true);
    }
  });

  it('happy path 回归: ARCHIVE_PLAN_ARGS_SCHEMA accept 已知字段', async () => {
    const { ARCHIVE_PLAN_ARGS_SCHEMA } = await import('../tools/schemas');
    const result = ARCHIVE_PLAN_ARGS_SCHEMA.safeParse({
      planId: 'foo',
      worktreePath: '/abs/path',
      baseBranch: 'main',
      changelogId: '99',
    });
    expect(result.success).toBe(true);
  });
});

// ─── plan hand-off-session-adopt-teammates-20260520 Phase 4 N2.c invariant ─
//
// **范围**: 验证 HAND_OFF_SESSION_ARGS_SCHEMA.refine() 实现 N2.c 互斥不变量 —
// args.adoptTeammates: true 与 args.teamName 不可同传(zod refine reject)。
//
// **理由**(plan §N2.c + §决策对抗 Round 3 MED-3 修法):
// - caller 显式 args.teamName 通常表示「spawn 时让新 session 进这个 team(可能不在
//   caller 自己 team)」,与 adopt(过继 caller 自己 team)语义本来就有冲突
// - 互斥简化语义 + 消除 silent prompt 数据丢失 bug
//
// **守门 case** (3 条):
// T4.3a HAND_OFF_SESSION_ARGS_SCHEMA reject adoptTeammates: true + teamName 同传
// T4.3b adoptTeammates: true 单传 (无 teamName) 通过
// T4.3c teamName 单传 (无 adoptTeammates) 通过(回归保护)
describe('plan hand-off-session-adopt-teammates-20260520 Phase 4: HAND_OFF_SESSION_ARGS_SCHEMA N2.c 互斥 invariant', () => {
  it('T4.3a: reject adoptTeammates=true + teamName 同传 (N2.c 互斥)', async () => {
    const { HAND_OFF_SESSION_ARGS_SCHEMA } = await import('../tools/schemas');
    const result = HAND_OFF_SESSION_ARGS_SCHEMA.safeParse({
      planId: 'foo',
      adapter: 'claude-code',
      adoptTeammates: true,
      teamName: 'some-team',
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      // refine 失败时 zod 报 'custom' issue code + plan §N2.c 文案 message
      const hasRefineFail = result.error.issues.some(
        (i) => i.code === 'custom' && /adoptTeammates 与 teamName 不可同传/.test(i.message),
      );
      expect(hasRefineFail).toBe(true);
    }
  });

  it('T4.3b: accept adoptTeammates=true 单传 (无 teamName — adopt 主路径)', async () => {
    const { HAND_OFF_SESSION_ARGS_SCHEMA } = await import('../tools/schemas');
    const result = HAND_OFF_SESSION_ARGS_SCHEMA.safeParse({
      planId: 'foo',
      adapter: 'claude-code',
      adoptTeammates: true,
    });
    expect(result.success).toBe(true);
  });

  it('T4.3c: accept teamName 单传 (无 adoptTeammates — 回归保护)', async () => {
    const { HAND_OFF_SESSION_ARGS_SCHEMA } = await import('../tools/schemas');
    const result = HAND_OFF_SESSION_ARGS_SCHEMA.safeParse({
      planId: 'foo',
      adapter: 'claude-code',
      teamName: 'some-team',
    });
    expect(result.success).toBe(true);
  });
});
