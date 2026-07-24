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
import type { AgentEvent, SessionRecord, AgentDeckMessage } from '@shared/types';
import { makeSessionRepoMock } from '@main/__tests__/_shared/mocks/session-repo';
import { makeSdkLoaderMock } from '@main/__tests__/_shared/mocks/sdk-loader';
import { makeSettingsStoreMock } from '@main/__tests__/_shared/mocks/settings-store';
import { makeAgentDeckTeamRepoMock } from '@main/__tests__/_shared/mocks/agent-deck-team-repo';
import type { AgentDeckTeamRepo } from '@main/store/agent-deck-team-repo';
import { eventBus } from '@main/event-bus';
// REVIEW_85 MED-1/MED-2: 从 mock 模块拿 TeamInvariantError（vi.mock 导出的同一 class），
// 让 addMemberThrow 抛的 error 能被 handler 的 `instanceof TeamInvariantError` 识别。
import { TeamInvariantError } from '@main/store/agent-deck-team-repo';
import { adapterRegistry } from '@main/adapters/registry';
// REVIEW_85 MED-A: 用真实 inFlightChildren 单例断言 spawn handler 抛错路径不泄漏计数
// （tools.test.ts 不 mock rate-limiter，handler 走真 spawn-guards → 真 inFlightChildren）。
import { inFlightChildren, spawnRateLimiter } from '../rate-limiter';

// ─── Mock: sessionRepo / sessionManager / adapterRegistry ──────────────
// R37 P2-F Step 3.1：sessionRepo / sdk-loader / settings-store / agent-deck-team-repo
// 走 _shared/mocks/ factory；vi.hoisted 让 sessionStore 等 const 在 vi.mock factory
// 调用前已初始化（factory immediate access 闭包外 const 撞 ReferenceError）。
const {
  sessionStore,
  setSpawnLinkCalls,
  setTitleCalls,
  listActiveAndDormantCalls,
  sessionGetThrow,
  eventStore,
  listForSessionCalls,
  handoffPredecessors,
} = vi.hoisted(() => ({
  sessionStore: new Map<string, SessionRecord>(),
  setSpawnLinkCalls: [] as Array<{ id: string; parentId: string | null; depth: number }>,
  setTitleCalls: [] as Array<{ id: string; title: string }>,
  listActiveAndDormantCalls: [] as Array<{
    limit: number;
    offset: number;
    lifecycle?: 'active' | 'dormant';
    spawnedBy?: string;
    agentId?: string;
  }>,
  // REVIEW_85 MED-A (reviewer-claude): sessionGetThrow.sid 非 null 时 sessionRepo.get(sid) 抛错,
  // 验证 applySpawnGuards 下移后 caller DB 读抛错不泄漏 in-flight 计数。
  sessionGetThrow: { sid: null as string | null },
  eventStore: new Map<string, Array<AgentEvent & { id: number }>>(),
  listForSessionCalls: [] as Array<{ sessionId: string; limit: number; offset: number }>,
  handoffPredecessors: new Map<string, string[]>(),
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
      listActiveAndDormant: (
        limit = 100,
        offset = 0,
        lifecycle?: 'active' | 'dormant',
        spawnedBy?: string,
        agentId?: string,
      ) => {
        listActiveAndDormantCalls.push({ limit, offset, lifecycle, spawnedBy, agentId });
        return [...sessionStore.values()]
          .filter((s) => s.lifecycle !== 'closed' && s.archivedAt == null)
          .filter((s) => (lifecycle ? s.lifecycle === lifecycle : true))
          .filter((s) => (spawnedBy !== undefined ? s.spawnedBy === spawnedBy : true))
          .filter((s) => (agentId !== undefined ? s.agentId === agentId : true))
          .sort((a, b) => (b.lastEventAt ?? 0) - (a.lastEventAt ?? 0))
          .slice(offset, offset + limit);
      },
    },
  }),
}));

vi.mock('@main/session/hand-off/ownership', () => ({
  isCurrentHandOffOwner: (owner: string | null, caller: string) =>
    owner === caller || (owner !== null && (handoffPredecessors.get(caller) ?? []).includes(owner)),
  sessionOwnershipLineage: (sessionId: string) => [
    sessionId,
    ...(handoffPredecessors.get(sessionId) ?? []),
  ],
  sessionOwnershipLineages: (sessionIds: string[]) => new Map(sessionIds.map((sessionId) => [
    sessionId,
    [sessionId, ...(handoffPredecessors.get(sessionId) ?? [])],
  ])),
  notifySessionHandOffCommitted: vi.fn(),
}));

const closeCalls: string[] = [];
let closeThrow: Error | null = null;
const recordPermCalls: Array<{ sid: string; mode: string | undefined }> = [];
const notifyTeamCalls: string[] = [];
// REVIEW_85 MED-B (reviewer-claude): 设 true 时 recordCreatedPermissionMode 抛错（验证 spawn
// 仍返回成功不产生孤儿活 session）。
let recordPermThrow = false;

vi.mock('@main/session/manager', () => ({
  sessionManager: {
    close: async (id: string) => {
      if (closeThrow) throw closeThrow;
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
let createSessionThrow: Error | null = null;
let createSessionGate: Promise<void> | null = null;
const sendMessageCalls: Array<{ sid: string; text: string }> = [];

// D1 (CHANGELOG_76): spy createSession opts 让 test 能断言 prompt 是否被 body 前缀注入。
const createSessionCalls: Array<{
  adapter: string;
  cwd: string;
  prompt?: string;
  teamName?: string;
  permissionMode?: string;
  codexSandbox?: string;
  claudeCodeSandbox?: string;
  provider?: string;
  model?: string;
  modelReasoningEffort?: string;
  claudeCodeEffortLevel?: string;
  developerInstructions?: string;
  codexConfigOverrides?: unknown;
  claudeAgentName?: string;
  claudeAgents?: unknown;
  extraAllowWrite?: readonly string[];
  awaitCanonicalId?: boolean;
  initialSpawnLink?: { parentSessionId: string; depth: number };
}> = [];

vi.mock('@main/adapters/registry', () => ({
  adapterRegistry: {
    get: (id: string) => {
      if (id !== 'claude-code' && id !== 'codex-cli' && id !== 'grok-build') {
        return undefined;
      }
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
          permissionMode?: string;
          codexSandbox?: string;
          claudeCodeSandbox?: string;
          provider?: string;
          model?: string;
          modelReasoningEffort?: string;
          claudeCodeEffortLevel?: string;
          developerInstructions?: string;
          codexConfigOverrides?: unknown;
          claudeAgentName?: string;
          claudeAgents?: unknown;
          extraAllowWrite?: readonly string[];
          awaitCanonicalId?: boolean;
          initialSessionRegistration?: {
            spawnLink: { parentSessionId: string; depth: number };
            onRegistered: (sessionId: string) => void;
          };
        }) => {
          if (createSessionThrow) throw createSessionThrow;
          const sid = nextSpawnedSid;
          createSessionCalls.push({
            adapter: id,
            cwd: opts.cwd,
            prompt: opts.prompt,
            teamName: opts.teamName,
            permissionMode: opts.permissionMode,
            codexSandbox: opts.codexSandbox,
            claudeCodeSandbox: opts.claudeCodeSandbox,
            provider: opts.provider,
            model: opts.model,
            modelReasoningEffort: opts.modelReasoningEffort,
            claudeCodeEffortLevel: opts.claudeCodeEffortLevel,
            developerInstructions: opts.developerInstructions,
            codexConfigOverrides: opts.codexConfigOverrides,
            claudeAgentName: opts.claudeAgentName,
            claudeAgents: opts.claudeAgents,
            extraAllowWrite: opts.extraAllowWrite,
            awaitCanonicalId: opts.awaitCanonicalId,
            initialSpawnLink: opts.initialSessionRegistration?.spawnLink,
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
            spawnedBy: opts.initialSessionRegistration?.spawnLink.parentSessionId ?? null,
            spawnDepth: opts.initialSessionRegistration?.spawnLink.depth ?? 0,
          });
          opts.initialSessionRegistration?.onRegistered(sid);
          if (createSessionGate) await createSessionGate;
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
    listForSession: (sessionId: string, limit = 200, offset = 0) => {
      listForSessionCalls.push({ sessionId, limit, offset });
      return (eventStore.get(sessionId) ?? []).slice(offset, offset + limit);
    },
    listValidForSession: (sessionId: string, limit = 200, offset = 0) => {
      listForSessionCalls.push({ sessionId, limit, offset });
      return (eventStore.get(sessionId) ?? []).slice(offset, offset + limit);
    },
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
      findActiveTeamMembershipsBySession: ((sid: string) =>
        mockMembershipsBySession.get(sid) ?? []) as unknown as AgentDeckTeamRepo['findActiveTeamMembershipsBySession'],
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
const insertedMessages: Array<{ id: string; teamId: string | null; fromSessionId: string; toSessionId: string; body: string; replyToMessageId: string | null }> = [];
const markedDelivered: string[] = [];
let nextInsertId = 1;
let enqueueMessageThrow: Error | null = null;
let enqueueRateLimitRetryAfterMs: number | null = null;

vi.mock('@main/store/agent-deck-message-repo', () => ({
  agentDeckMessageRepo: {
    get: (id: string) => mockMessages.get(id) ?? null,
    insert: (input: { id?: string; teamId: string | null; fromSessionId: string; toSessionId: string; body: string; replyToMessageId?: string | null }) => {
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
    if (enqueueMessageThrow) throw enqueueMessageThrow;
    enqueuedMessages.push(input);
    if (enqueueRateLimitRetryAfterMs !== null) {
      return {
        ok: false as const,
        error: 'message rate limit exceeded',
        retryAfterMs: enqueueRateLimitRetryAfterMs,
      };
    }
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

vi.mock('@main/claude-config/custom-agents', () => ({
  resolveClaudeAgentContent: (name: string) => {
    if (name === 'reviewer-claude') {
      return {
        ok: true,
        agent: {
          name,
          source: 'bundled',
          model: 'opus',
          definition: {
            description: 'Mock Claude reviewer',
            prompt: '# REVIEWER-CLAUDE BODY (mocked)\n你是对抗 reviewer。',
          },
        },
      };
    }
    return { ok: false, reason: `not found: ${name}` };
  },
}));

vi.mock('@main/codex-config/custom-agents', () => ({
  resolveCodexAgentContent: (name: string) => {
    if (name === 'reviewer-codex') {
      return {
        ok: true,
        agent: {
          name,
          source: 'bundled',
          sourcePath: '/mock/reviewer-codex.toml',
          description: 'Mock Codex reviewer',
          developerInstructions: '# REVIEWER-CODEX BODY (mocked)',
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
    return { ok: false, reason: `not found: ${name}` };
  },
}));

// ─── 动态 import 必须放在 mock 之后 ──────────────────────────────────────

let buildAgentDeckTools: typeof import('../tools').buildAgentDeckTools;

beforeEach(async () => {
  sessionStore.clear();
  setSpawnLinkCalls.length = 0;
  setTitleCalls.length = 0;
  listActiveAndDormantCalls.length = 0;
  addMemberCalls.length = 0;
  closeCalls.length = 0;
  closeThrow = null;
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
  eventStore.clear();
  listForSessionCalls.length = 0;
  handoffPredecessors.clear();
  inFlightChildren.reset();
  spawnRateLimiter.reset();
  mockMessages.clear();
  insertedMessages.length = 0;
  markedDelivered.length = 0;
  nextInsertId = 1;
  enqueueMessageThrow = null;
  enqueueRateLimitRetryAfterMs = null;
  nextSpawnedSid = 'spawned-1';
  createSessionThrow = null;
  createSessionGate = null;
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

function seedEvent(sessionId: string, id: number, opts: Partial<AgentEvent> = {}) {
  const events = eventStore.get(sessionId) ?? [];
  events.push({
    id,
    sessionId,
    agentId: 'claude-code',
    kind: 'message',
    payload: { role: 'assistant', text: `event-${id}` },
    ts: Date.now() - id,
    source: 'sdk',
    ...opts,
  } as AgentEvent & { id: number });
  eventStore.set(sessionId, events);
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

  it('schema exposes context mode, model, and thinking without changing omitted defaults', async () => {
    const { SPAWN_SESSION_MODEL_VALUES, SPAWN_SESSION_SCHEMA } = await import('../tools/schemas');
    expect(SPAWN_SESSION_MODEL_VALUES).toEqual([
      'haiku',
      'sonnet',
      'opus',
      'fable',
      'gpt-5.6-sol',
      'gpt-5.6-terra',
      'gpt-5.6-luna',
      'gpt-5.5',
      'gpt-5.4',
      'deepseek-v4-flash',
      'deepseek-v4-pro[1m]',
      'grok-4.5',
    ]);
    expect(SPAWN_SESSION_MODEL_VALUES).not.toContain('fable-5');
    expect(SPAWN_SESSION_MODEL_VALUES).not.toContain('gpt-5.6');
    expect(SPAWN_SESSION_SCHEMA.model.unwrap().safeParse('claude-opus-4-8').success).toBe(true);
    expect(SPAWN_SESSION_SCHEMA.model.unwrap().safeParse('').success).toBe(false);
    expect(SPAWN_SESSION_SCHEMA.model.description).not.toContain('fable-5');
    expect(SPAWN_SESSION_SCHEMA.model.description).toContain('gpt-5.6-sol');
    expect(SPAWN_SESSION_SCHEMA.model.description).toContain('gpt-5.6-terra');
    expect(SPAWN_SESSION_SCHEMA.model.description).toContain('gpt-5.6-luna');
    expect(SPAWN_SESSION_SCHEMA.model.description).toContain('Suggestions are not an allowlist');
    expect(SPAWN_SESSION_SCHEMA.model.description).toContain(
      'explicit model > resolved agent model > same-adapter source session > provider default',
    );
    expect(SPAWN_SESSION_SCHEMA.model.description).toContain('spawned session only');
    expect(SPAWN_SESSION_SCHEMA.thinking.unwrap().options).toEqual([
      'low',
      'medium',
      'high',
      'xhigh',
      'max',
      'ultra',
    ]);
    expect(SPAWN_SESSION_SCHEMA.thinking.safeParse('minimal').success).toBe(false);
    expect(SPAWN_SESSION_SCHEMA.thinking.description).toContain(
      'explicit thinking > resolved agent effort > same-adapter source session > provider default',
    );
    expect(SPAWN_SESSION_SCHEMA.thinking.description).toContain(
      'Claude accepts low, medium, high, xhigh, and max',
    );
    expect(SPAWN_SESSION_SCHEMA.thinking.description).toContain(
      'Grok Build accepts low, medium, high, and xhigh',
    );
    expect(SPAWN_SESSION_SCHEMA.contextMode.safeParse(undefined).success).toBe(true);
    expect(SPAWN_SESSION_SCHEMA.contextMode.safeParse('fresh').success).toBe(true);
    expect(SPAWN_SESSION_SCHEMA.contextMode.safeParse('fork').success).toBe(true);
    expect(SPAWN_SESSION_SCHEMA.contextMode.safeParse('3').success).toBe(false);
    expect(SPAWN_SESSION_SCHEMA.contextMode.description).toContain('authenticated caller');
    expect(SPAWN_SESSION_SCHEMA.contextMode.description).toContain('same real directory');
    expect(SPAWN_SESSION_SCHEMA.contextMode.description).toContain('never silently downgrades');
  });

  it('tool description points callers to the field schemas and self-correcting hint', async () => {
    const tools = await getTools({ transport: 'http' });
    const description = tools.get('spawn_session').description as string;
    expect(description).toContain('Required fields: adapter, absolute cwd');
    expect(description).toContain('Use provider for a Claude Gateway profile');
    expect(description).toContain('Runtime precedence is explicit provider/model/thinking');
    expect(description).toContain('follow hint exactly');
    expect(description).toContain('contextMode defaults to fresh');
    expect(description).toContain('safe active-turn boundary');
    expect(description).toContain('hand-offs always start fresh');
  });

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
    expect(parsed.data.spawnDepth).toBe(1);
    expect(parsed.data.spawnLimits).toMatchObject({
      depth: { current: 0, next: 1, max: 3 },
      fanOut: { current: 1, activeChildren: 1, inFlight: 0, max: 5 },
      rate: { current: 1, max: 100, windowMs: 60_000, retryAfterMs: 0 },
    });
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
      extraAllowWrite: ['/main-repo', '/shared-cache'],
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
    expect(createSessionCalls[0].extraAllowWrite).toEqual(['/main-repo', '/shared-cache']);
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
      extraAllowWrite: ['/codex-extra-root'],
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
    expect(createSessionCalls[0].extraAllowWrite).toBeUndefined();
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
      extraAllowWrite: ['/explicit-root'],
      callerSessionId: 'lead',
    }, {});
    const parsed = parseResult(r);
    expect(parsed.isError).toBeFalsy();
    expect(createSessionCalls).toHaveLength(1);
    expect(createSessionCalls[0].permissionMode).toBe('acceptEdits');
    expect(createSessionCalls[0].claudeCodeSandbox).toBe('workspace-write');
    expect(createSessionCalls[0].extraAllowWrite).toEqual(['/explicit-root']);
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

  it('codex spawn returns a canonical id that remains usable by follow-up send_message', async () => {
    const tools = await getTools({ transport: 'http' });
    seedSession('lead', {
      cwd: '/repo',
      agentId: 'claude-code',
    });
    nextSpawnedSid = 'real-codex-after-thread-started';

    const spawn = await tools.get('spawn_session').handler({
      adapter: 'codex-cli',
      cwd: '/repo',
      prompt: 'codex teammate task',
      callerSessionId: 'lead',
    }, {});
    const spawned = parseResult(spawn);

    expect(spawned.isError).toBeFalsy();
    expect(spawned.data.sessionId).toBe('real-codex-after-thread-started');
    expect(createSessionCalls).toHaveLength(1);
    expect(createSessionCalls[0].awaitCanonicalId).toBe(true);
    expect(createSessionCalls[0].initialSpawnLink).toEqual({
      parentSessionId: 'lead',
      depth: 1,
    });
    expect(sessionStore.get(spawned.data.sessionId)).toMatchObject({
      spawnedBy: 'lead',
      spawnDepth: 1,
    });
    expect(inFlightChildren.get('lead')).toBe(0);
    expect(sessionStore.has(spawned.data.sessionId)).toBe(true);

    const followUp = await tools.get('send_message').handler({
      sessionId: spawned.data.sessionId,
      text: 'second-round prompt',
      callerSessionId: 'lead',
    }, {});
    const sent = parseResult(followUp);

    expect(sent.isError).toBeFalsy();
    expect(sent.data.queued).toBe(true);
    expect(enqueuedMessages).toContainEqual({
      teamId: null,
      fromSessionId: 'lead',
      toSessionId: 'real-codex-after-thread-started',
      body: 'second-round prompt',
      replyToMessageId: null,
    });
  });

  it('materializes the spawn edge and releases fan-out reservation before canonical create settles', async () => {
    seedSession('lead', { cwd: '/repo', agentId: 'codex-cli' });
    let releaseCreate!: () => void;
    createSessionGate = new Promise<void>((resolve) => {
      releaseCreate = resolve;
    });
    const { spawnSessionHandler } = await import('../tools/handlers/spawn');

    const pending = spawnSessionHandler(
      {
        adapter: 'codex-cli',
        cwd: '/repo',
        prompt: 'deferred canonical child',
        callerSessionId: 'lead',
      },
      { caller: { callerSessionId: 'lead', transport: 'in-process' } },
    );

    await vi.waitFor(() => {
      expect(sessionStore.get('spawned-1')).toMatchObject({
        spawnedBy: 'lead',
        spawnDepth: 1,
      });
    });
    expect(inFlightChildren.get('lead')).toBe(0);
    expect(setSpawnLinkCalls).toHaveLength(0);

    releaseCreate();
    const result = parseResult(await pending);
    expect(result.isError).toBeFalsy();
    expect(setSpawnLinkCalls).toEqual([
      { id: 'spawned-1', parentId: 'lead', depth: 1 },
    ]);
  });

  it.each(['max', 'ultra'] as const)(
    'passes codex model and %s thinking to createSession',
    async (thinking) => {
      const tools = await getTools({ transport: 'http' });
      seedSession('lead', { cwd: '/repo', agentId: 'claude-code' });
      const r = await tools.get('spawn_session').handler({
        adapter: 'codex-cli',
        cwd: '/repo',
        prompt: 'codex model task',
        model: 'gpt-5.6-sol',
        thinking,
        callerSessionId: 'lead',
      }, {});
      const parsed = parseResult(r);
      expect(parsed.isError).toBeFalsy();
      expect(createSessionCalls).toHaveLength(1);
      expect(createSessionCalls[0].model).toBe('gpt-5.6-sol');
      expect(createSessionCalls[0].modelReasoningEffort).toBe(thinking);
      expect(createSessionCalls[0].claudeCodeEffortLevel).toBeUndefined();
    },
  );

  it('passes claude-family thinking as sanitized Claude Code effort level', async () => {
    const tools = await getTools({ transport: 'http' });
    seedSession('lead', { cwd: '/repo', agentId: 'codex-cli' });
    const r = await tools.get('spawn_session').handler({
      adapter: 'claude-code',
      cwd: '/repo',
      prompt: 'claude model task',
      model: 'fable',
      thinking: 'max',
      callerSessionId: 'lead',
    }, {});
    const parsed = parseResult(r);
    expect(parsed.isError).toBeFalsy();
    expect(createSessionCalls).toHaveLength(1);
    expect(createSessionCalls[0].model).toBe('fable');
    expect(createSessionCalls[0].claudeCodeEffortLevel).toBe('max');
    expect(createSessionCalls[0].modelReasoningEffort).toBeUndefined();
  });

  it('passes an explicit Deepseek Gateway profile and model without adapter aliases', async () => {
    const tools = await getTools({ transport: 'http' });
    seedSession('lead', { cwd: '/repo', agentId: 'claude-code' });
    const r = await tools.get('spawn_session').handler({
      adapter: 'claude-code',
      provider: 'deepseek',
      cwd: '/repo',
      prompt: 'deepseek model task',
      model: 'deepseek-v4-pro[1m]',
      thinking: 'high',
      callerSessionId: 'lead',
    }, {});
    const parsed = parseResult(r);
    expect(parsed.isError).toBeFalsy();
    expect(createSessionCalls).toHaveLength(1);
    expect(createSessionCalls[0].adapter).toBe('claude-code');
    expect(createSessionCalls[0].provider).toBe('deepseek');
    expect(createSessionCalls[0].model).toBe('deepseek-v4-pro[1m]');
    expect(createSessionCalls[0].claudeCodeEffortLevel).toBe('high');
  });

  it('passes custom provider model names through to the target SDK', async () => {
    const tools = await getTools({ transport: 'http' });
    seedSession('lead', { cwd: '/repo', agentId: 'claude-code' });
    const r = await tools.get('spawn_session').handler({
      adapter: 'claude-code',
      cwd: '/repo',
      prompt: 'custom model task',
      model: 'claude-opus-4-8-thinking-max[1m]',
      callerSessionId: 'lead',
    }, {});
    const parsed = parseResult(r);
    expect(parsed.isError).toBeFalsy();
    expect(createSessionCalls).toHaveLength(1);
    expect(createSessionCalls[0].model).toBe('claude-opus-4-8-thinking-max[1m]');
  });

  it('rejects thinking values that belong to a different adapter before createSession', async () => {
    const tools = await getTools({ transport: 'http' });
    seedSession('lead', { cwd: '/repo', agentId: 'claude-code' });

    const cases = [
      {
        adapter: 'claude-code',
        thinking: 'minimal',
        message: /thinking "minimal" is not valid for adapter "claude-code"/,
      },
      {
        adapter: 'claude-code',
        thinking: 'ultra',
        message: /thinking "ultra" is not valid for adapter "claude-code"/,
      },
    ] as const;

    for (const c of cases) {
      const r = await tools.get('spawn_session').handler({
        adapter: c.adapter,
        cwd: '/repo',
        prompt: 'bad thinking task',
        thinking: c.thinking,
        callerSessionId: 'lead',
      }, {});
      const parsed = parseResult(r);
      expect(parsed.isError).toBe(true);
      expect(parsed.data.error).toMatch(c.message);
      expect(parsed.data.hint).toBe('Use one of: low, medium, high, xhigh, max.');
    }
    expect(createSessionCalls).toHaveLength(0);
  });

  it('passes claude-family thinking xhigh through as Claude Code effort', async () => {
    const tools = await getTools({ transport: 'http' });
    seedSession('lead', { cwd: '/repo', agentId: 'claude-code' });
    const r = await tools.get('spawn_session').handler({
      adapter: 'claude-code',
      cwd: '/repo',
      prompt: 'xhigh thinking task',
      thinking: 'xhigh',
      callerSessionId: 'lead',
    }, {});
    const parsed = parseResult(r);
    expect(parsed.isError).toBeFalsy();
    expect(createSessionCalls).toHaveLength(1);
    expect(createSessionCalls[0].claudeCodeEffortLevel).toBe('xhigh');
    expect(createSessionCalls[0].modelReasoningEffort).toBeUndefined();
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

  it('teamless spawn injects wire prefix + placeholder so the child can reply with send_message', async () => {
    const tools = await getTools({ transport: 'http' });
    seedSession('lead', { cwd: '/repo' });
    const emitSpy = vi.spyOn(eventBus, 'emit');
    const r = await tools.get('spawn_session').handler({
      adapter: 'codex-cli',
      cwd: '/repo',
      prompt: 'standalone task',
      // 不传 teamName → standalone child, but still has a teamless DM reply anchor.
      callerSessionId: 'lead',
    }, {});
    const parsed = parseResult(r);
    expect(parsed.isError).toBeFalsy();
    const spawnId = parsed.data.spawnPromptMessageId;
    expect(spawnId).toMatch(/^[0-9a-f-]{36}$/);
    expect(createSessionCalls).toHaveLength(1);
    const seenPrompt = createSessionCalls[0].prompt as string;
    expect(seenPrompt).toMatch(new RegExp(`^\\[from .+ @ .+\\]\\[msg ${spawnId}\\]\\[sid lead\\]\\n`));
    expect(seenPrompt).toContain('standalone task');
    expect(seenPrompt).toContain('Team id: (none; omit `teamId` so send_message uses teamless DM)');
    expect(seenPrompt).not.toContain("teamId: '");
    expect(insertedMessages).toEqual([
      {
        id: spawnId,
        teamId: null,
        fromSessionId: 'lead',
        toSessionId: 'spawned-1',
        body: 'standalone task',
        replyToMessageId: null,
      },
    ]);
    expect(markedDelivered).toEqual([spawnId]);
    expect(emitSpy).toHaveBeenCalledWith(
      'session-upserted',
      expect.objectContaining({ id: 'spawned-1', spawnedBy: 'lead', spawnDepth: 1 }),
    );
    emitSpy.mockRestore();
  });

  it('Phase B7 / CHANGELOG_100: spawn with agentName + teamName → wire prefix wraps caller prompt while native agent config is passed separately', async () => {
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
    // wire prefix 三段 + lead context block + --- + caller prompt 顺序
    const seenPrompt = createSessionCalls[0].prompt as string;
    expect(seenPrompt).toMatch(new RegExp(`^\\[from .+ @ .+\\]\\[msg ${spawnId}\\]\\[sid lead\\]\\n`));
    expect(seenPrompt).toContain('## Hand-off context (auto-injected by Agent Deck MCP)');
    expect(seenPrompt).toContain('task body: review src/foo.ts');
    expect(seenPrompt).not.toContain('# REVIEWER-CLAUDE BODY (mocked)');
    expect(createSessionCalls[0].claudeAgentName).toBe('reviewer-claude');
    expect(createSessionCalls[0].claudeAgents).toMatchObject({
      'reviewer-claude': {
        prompt: '# REVIEWER-CLAUDE BODY (mocked)\n你是对抗 reviewer。',
      },
    });
    // DB body 不含 wire prefix / lead context block / native agent body，保留 caller prompt。
    expect(insertedMessages[0].body).toBe('task body: review src/foo.ts');
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
    expect(parsed.data.hint).toContain('adapter value from the tool schema');
    getSpy.mockRestore();
  });

  it('preserves createSession errors and returns an actionable retry contract', async () => {
    const tools = await getTools({ transport: 'http' });
    seedSession('lead', { cwd: '/repo', agentId: 'codex-cli' });
    createSessionThrow = new Error('provider rejected model gpt-unknown');

    const r = await tools.get('spawn_session').handler({
      adapter: 'codex-cli',
      cwd: '/repo',
      prompt: 'model retry task',
      model: 'gpt-unknown',
      thinking: 'ultra',
      callerSessionId: 'lead',
    }, {});
    const parsed = parseResult(r);

    expect(parsed.isError).toBe(true);
    expect(parsed.data.error).toBe('provider rejected model gpt-unknown');
    expect(parsed.data.hint).toContain('No session was created');
    expect(parsed.data.hint).toContain('thinking value supported by codex-cli');
    expect(parsed.data.hint).toContain('omit model/thinking');
    expect(parsed.data.hint).toContain('verify adapter authentication');
    expect(sessionStore.has('spawned-1')).toBe(false);
  });

  it('agentName passes native Claude SDK agent config while wrapping only the caller task prompt', async () => {
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
    const seenPrompt = createSessionCalls[0].prompt as string;
    expect(seenPrompt).toContain('task body: review src/foo.ts');
    expect(seenPrompt).toContain('## Hand-off context (auto-injected by Agent Deck MCP)');
    expect(seenPrompt).not.toContain('# REVIEWER-CLAUDE BODY (mocked)');
    expect(createSessionCalls[0].claudeAgentName).toBe('reviewer-claude');
    expect(createSessionCalls[0].claudeAgents).toMatchObject({
      'reviewer-claude': {
        prompt: '# REVIEWER-CLAUDE BODY (mocked)\n你是对抗 reviewer。',
      },
    });
    expect(createSessionCalls[0].model).toBe('opus');
    expect(insertedMessages[0]).toMatchObject({
      teamId: null,
      fromSessionId: 'lead',
      toSessionId: 'spawned-1',
      body: 'task body: review src/foo.ts',
      replyToMessageId: null,
    });
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
    expect(parsed.data.error).toMatch(/agent not found/);
    // 没静默 spawn
    expect(createSessionCalls).toHaveLength(0);
  });

  it('agentName omitted → wraps caller prompt with teamless reply anchor', async () => {
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
    const spawnId = parsed.data.spawnPromptMessageId;
    const seenPrompt = createSessionCalls[0].prompt as string;
    expect(seenPrompt).toMatch(new RegExp(`^\\[from .+ @ .+\\]\\[msg ${spawnId}\\]\\[sid lead\\]\\n`));
    expect(seenPrompt).toContain('plain prompt without body');
    expect(insertedMessages[0]).toMatchObject({
      id: spawnId,
      teamId: null,
      body: 'plain prompt without body',
    });
  });

  it('regression Bug 1+2: native agent definition is passed as object without leaking [object Object] into prompt or DB body', async () => {
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
    expect(createSessionCalls[0].prompt).not.toContain('# REVIEWER-CLAUDE BODY (mocked)');
    expect(createSessionCalls[0].claudeAgents).toMatchObject({
      'reviewer-claude': {
        prompt: '# REVIEWER-CLAUDE BODY (mocked)\n你是对抗 reviewer。',
      },
    });
    expect(insertedMessages[0].body).not.toContain('[object Object]');
    expect(insertedMessages[0].body).toBe('task body');
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
    expect(createSessionCalls.at(-1)?.initialSpawnLink).toBeUndefined();
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

  it('resolves target cliSessionId aliases before team checks and enqueue', async () => {
    const tools = await getTools({ transport: 'http' });
    seedSession('worker');
    seedSession('lead-app-sid', {
      agentId: 'codex-cli',
      cliSessionId: 'lead-cli-sid',
    });
    setSharedTeams('worker', 'lead-app-sid', ['team-X']);

    const r = await tools.get('send_message').handler({
      sessionId: 'lead-cli-sid',
      text: 'benchmark result',
      callerSessionId: 'worker',
    }, {});

    const parsed = parseResult(r);
    expect(parsed.isError).toBeFalsy();
    expect(parsed.data.sessionId).toBe('lead-app-sid');
    expect(parsed.data.teamId).toBe('team-X');
    expect(enqueuedMessages).toEqual([
      {
        teamId: 'team-X',
        fromSessionId: 'worker',
        toSessionId: 'lead-app-sid',
        body: 'benchmark result',
        replyToMessageId: null,
      },
    ]);
  });

  it('routes an old handoff target even after its source row is gone', async () => {
    const tools = await getTools({ transport: 'http' });
    seedSession('lead');
    seedSession('old-teammate', { lifecycle: 'closed' });
    seedSession('new-teammate', { agentId: 'codex-cli' });
    setSharedTeams('lead', 'new-teammate', ['team-X']);
    mockMessages.set('old-handoff-wire', {
      id: 'old-handoff-wire',
      teamId: 'team-X',
      fromSessionId: 'old-teammate',
      toSessionId: 'lead',
      body: 'reply using this old wire anchor',
      status: 'delivered',
      statusReason: null,
      sentAt: 1_000,
      deliveredAt: 1_100,
      attemptCount: 1,
      lastAttemptAt: 1_000,
      deliveringSince: null,
      replyToMessageId: null,
    });
    const { handOffCutoverCoordinator } = await import(
      '@main/session/hand-off/cutover-coordinator'
    );
    const lease = handOffCutoverCoordinator.tryAcquire('old-teammate')!;
    expect(lease.commit('new-teammate')).toBe(true);
    lease.release();
    sessionStore.delete('old-teammate');

    const result = await tools.get('send_message').handler({
      sessionId: 'old-teammate',
      text: 'reply after handoff',
      teamId: 'team-X',
      replyToMessageId: 'old-handoff-wire',
      callerSessionId: 'lead',
    }, {});

    const parsed = parseResult(result);
    expect(parsed.isError).toBeFalsy();
    expect(parsed.data.sessionId).toBe('new-teammate');
    expect(enqueuedMessages).toEqual([{
      teamId: 'team-X',
      fromSessionId: 'lead',
      toSessionId: 'new-teammate',
      body: 'reply after handoff',
      replyToMessageId: 'old-handoff-wire',
    }]);
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
    expect(parsed.data.hint).toContain('Call list_sessions');
    expect(parsed.data.hint).toContain('call spawn_session');
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
    expect(parsed.data.hint).toContain('returned sessionId');
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
    expect(parsed.data.hint).toContain('shared active set shown in the error');
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
    expect(parsed.data.hint).toContain('restore the target');
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
    expect(parsed.data.hint).toContain('restore or replace this session');
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
    expect(parsed.data.hint).toContain('start a new thread with this target');
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
    expect(parsed.data.hint).toContain("original message's teamId");
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
    expect(parsed.data.error).toContain('team-X, team-Y');
    expect(parsed.data.hint).toBe('Retry with teamId set to one of the listed IDs.');
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
    expect(parsed.data.hint).toBe(
      'Omit replyToMessageId to start a new thread, or use the messageId from the latest wire prefix.',
    );
    expect(parsed.data.hint).not.toContain('list_sessions');
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
    expect(parsed.data.hint).toContain('omit replyToMessageId');
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

  it('returns the exact rate-limit delay and user-controlled recovery action', async () => {
    const tools = await getTools({ transport: 'http' });
    seedSession('lead');
    seedSession('teammate', { agentId: 'claude-code' });
    setSharedTeams('lead', 'teammate', ['team-X']);
    enqueueRateLimitRetryAfterMs = 1250;

    const r = await tools.get('send_message').handler({
      sessionId: 'teammate',
      text: 'retry later',
      callerSessionId: 'lead',
    }, {});
    const parsed = parseResult(r);

    expect(parsed.isError).toBe(true);
    expect(parsed.data.error).toContain('retryAfterMs=1250');
    expect(parsed.data.hint).toContain('Wait at least 1250 ms, then retry once');
    expect(parsed.data.hint).toContain('ask the user to update');
  });

  it('converts enqueue invariants and storage exceptions into self-correcting errors', async () => {
    const tools = await getTools({ transport: 'http' });
    seedSession('lead');
    seedSession('teammate', { agentId: 'claude-code' });
    enqueueMessageThrow = new Error('message body invariant failed');

    const r = await tools.get('send_message').handler({
      sessionId: 'teammate',
      text: 'invalid payload',
      callerSessionId: 'lead',
    }, {});
    const parsed = parseResult(r);

    expect(parsed.isError).toBe(true);
    expect(parsed.data.error).toBe('message body invariant failed');
    expect(parsed.data.hint).toContain('Correct any message invariant named in the error');
    expect(parsed.data.hint).toContain('retry once');
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
    expect(parsed.data.hint).toContain('use hand_off_session');
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
    expect(parsed.data.hint).toContain('Call list_sessions');
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

  it('preserves close errors and tells the caller how to verify before retrying', async () => {
    const tools = await getTools({ transport: 'http' });
    seedSession('lead');
    seedSession('teammate', { lifecycle: 'active' });
    closeThrow = new Error('adapter close failed');

    const r = await tools.get('shutdown_session').handler({
      sessionId: 'teammate',
      callerSessionId: 'lead',
    }, {});
    const parsed = parseResult(r);

    expect(parsed.isError).toBe(true);
    expect(parsed.data.error).toBe('adapter close failed');
    expect(parsed.data.hint).toContain('Call get_session with this sessionId');
    expect(parsed.data.hint).toContain('retry once');
  });
});

describe('agent-deck-mcp tools — list_sessions', () => {
  it('defaults to caller-related sessions only', async () => {
    const tools = await getTools({ transport: 'http' });
    seedSession('parent');
    seedSession('caller', { spawnedBy: 'parent', spawnDepth: 1 });
    seedSession('child', { spawnedBy: 'caller', spawnDepth: 2 });
    seedSession('grandchild', { spawnedBy: 'child', spawnDepth: 3 });
    seedSession('team-peer');
    seedSession('unrelated');
    seedSession('other-team-peer');
    mockMembershipsBySession.set('caller', [{ teamId: 'team-x' }]);
    mockMembershipsBySession.set('team-peer', [{ teamId: 'team-x' }]);
    mockMembershipsBySession.set('other-team-peer', [{ teamId: 'team-y' }]);
    mockTeamsById.set('team-x', { name: 'team-x' });
    mockTeamsById.set('team-y', { name: 'team-y' });

    const r = await tools.get('list_sessions').handler({
      callerSessionId: 'caller',
      statusFilter: 'active',
      limit: 50,
    }, {});
    const parsed = parseResult(r);
    expect(parsed.isError).toBeFalsy();
    expect(parsed.data.sessions.map((s: any) => s.sessionId).sort()).toEqual([
      'caller',
      'child',
      'grandchild',
      'parent',
      'team-peer',
    ]);
  });

  it('keeps predecessor descendants visible to the current handoff owner', async () => {
    const tools = await getTools({ transport: 'http' });
    seedSession('source', { lifecycle: 'closed' });
    seedSession('successor');
    seedSession('source-child', { spawnedBy: 'source', spawnDepth: 1 });
    seedSession('unrelated');
    handoffPredecessors.set('successor', ['source']);

    const r = await tools.get('list_sessions').handler({
      callerSessionId: 'successor',
      statusFilter: 'active',
      limit: 50,
    }, {});

    expect(parseResult(r).data.sessions.map((s: any) => s.sessionId).sort()).toEqual([
      'source-child',
      'successor',
    ]);
  });

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
    seedSession('caller', { agentId: 'claude-code' });
    seedSession('claude-child', { agentId: 'claude-code', spawnedBy: 'caller' });
    seedSession('codex-child', { agentId: 'codex-cli', spawnedBy: 'caller' });
    seedSession('unrelated-codex', { agentId: 'codex-cli' });
    const r = await tools.get('list_sessions').handler({
      callerSessionId: 'caller',
      statusFilter: 'active',
      adapterFilter: 'codex-cli',
      limit: 50,
    }, {});
    const parsed = parseResult(r);
    expect(parsed.data.sessions).toHaveLength(1);
    expect(parsed.data.sessions[0].sessionId).toBe('codex-child');
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

  it('keeps explicit spawnedByFilter broad for reset rescue', async () => {
    const tools = await getTools({ transport: 'http' });
    seedSession('caller');
    seedSession('old-lead');
    seedSession('old-child', { spawnedBy: 'old-lead' });
    seedSession('unrelated');
    const r = await tools.get('list_sessions').handler({
      callerSessionId: 'caller',
      statusFilter: 'active',
      spawnedByFilter: 'old-lead',
      limit: 50,
    }, {});
    const parsed = parseResult(r);
    expect(parsed.isError).toBeFalsy();
    expect(parsed.data.sessions).toHaveLength(1);
    expect(parsed.data.sessions[0].sessionId).toBe('old-child');
  });

  it('supports offset for explicit spawnedByFilter rescue pages', async () => {
    const tools = await getTools({ transport: 'http' });
    seedSession('caller');
    seedSession('old-lead');
    seedSession('old-child-1', { spawnedBy: 'old-lead', lastEventAt: 300 });
    seedSession('old-child-2', { spawnedBy: 'old-lead', lastEventAt: 200 });
    seedSession('old-child-3', { spawnedBy: 'old-lead', lastEventAt: 100 });
    const r = await tools.get('list_sessions').handler({
      callerSessionId: 'caller',
      statusFilter: 'active',
      spawnedByFilter: 'old-lead',
      limit: 1,
      offset: 1,
    }, {});
    const parsed = parseResult(r);
    expect(parsed.isError).toBeFalsy();
    expect(parsed.data.sessions).toHaveLength(1);
    expect(parsed.data.sessions[0].sessionId).toBe('old-child-2');
    expect(parsed.data.hasMore).toBe(true);
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
    expect(listActiveAndDormantCalls[0]).toMatchObject({
      lifecycle: 'active',
      spawnedBy: 'lead',
      agentId: 'claude-code',
    });
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

describe('agent-deck-mcp tools — list_session_events', () => {
  it('allows self reads and returns paged normalized events', async () => {
    const tools = await getTools({ transport: 'http' });
    seedSession('caller');
    seedEvent('caller', 1, { payload: { role: 'assistant', text: 'newest' }, ts: 300 });
    seedEvent('caller', 2, { payload: { role: 'assistant', text: 'middle' }, ts: 200 });
    seedEvent('caller', 3, { payload: { role: 'assistant', text: 'oldest' }, ts: 100 });

    const r = await tools.get('list_session_events').handler({
      callerSessionId: 'caller',
      sessionId: 'caller',
      limit: 2,
      offset: 0,
    }, {});
    const parsed = parseResult(r);
    expect(parsed.isError).toBeFalsy();
    expect(parsed.data.sessionId).toBe('caller');
    expect(parsed.data.hasMore).toBe(true);
    expect(parsed.data.events.map((e: any) => e.id)).toEqual([1, 2]);
    expect(listForSessionCalls).toEqual([{ sessionId: 'caller', limit: 3, offset: 0 }]);
  });

  it('allows spawn ancestor and descendant reads', async () => {
    const tools = await getTools({ transport: 'http' });
    seedSession('parent');
    seedSession('child', { spawnedBy: 'parent', spawnDepth: 1 });
    seedEvent('parent', 1);
    seedEvent('child', 2);

    const parentReadsChild = await tools.get('list_session_events').handler({
      callerSessionId: 'parent',
      sessionId: 'child',
      limit: 10,
    }, {});
    const childReadsParent = await tools.get('list_session_events').handler({
      callerSessionId: 'child',
      sessionId: 'parent',
      limit: 10,
    }, {});

    expect(parseResult(parentReadsChild).isError).toBeFalsy();
    expect(parseResult(parentReadsChild).data.events[0].sessionId).toBe('child');
    expect(parseResult(childReadsParent).isError).toBeFalsy();
    expect(parseResult(childReadsParent).data.events[0].sessionId).toBe('parent');
  });

  it('preserves predecessor and predecessor-descendant reads for a chained handoff owner', async () => {
    const tools = await getTools({ transport: 'http' });
    seedSession('source', { lifecycle: 'closed' });
    seedSession('middle', { lifecycle: 'closed' });
    seedSession('successor');
    seedSession('source-child', { spawnedBy: 'source', spawnDepth: 1 });
    handoffPredecessors.set('successor', ['source', 'middle']);
    seedEvent('source', 1);
    seedEvent('source-child', 2);

    const sourceRead = await tools.get('list_session_events').handler({
      callerSessionId: 'successor',
      sessionId: 'source',
      limit: 10,
    }, {});
    const childRead = await tools.get('list_session_events').handler({
      callerSessionId: 'successor',
      sessionId: 'source-child',
      limit: 10,
    }, {});

    expect(parseResult(sourceRead).isError).toBeFalsy();
    expect(parseResult(childRead).isError).toBeFalsy();
  });

  it('allows shared active team reads', async () => {
    const tools = await getTools({ transport: 'http' });
    seedSession('caller');
    seedSession('peer');
    setSharedTeams('caller', 'peer', ['team-x']);
    seedEvent('peer', 1);

    const r = await tools.get('list_session_events').handler({
      callerSessionId: 'caller',
      sessionId: 'peer',
      limit: 10,
    }, {});
    const parsed = parseResult(r);
    expect(parsed.isError).toBeFalsy();
    expect(parsed.data.events).toHaveLength(1);
    expect(parsed.data.events[0].sessionId).toBe('peer');
  });

  it('rejects unrelated sessions without reading events', async () => {
    const tools = await getTools({ transport: 'http' });
    seedSession('caller');
    seedSession('unrelated');
    seedEvent('unrelated', 1);

    const r = await tools.get('list_session_events').handler({
      callerSessionId: 'caller',
      sessionId: 'unrelated',
      limit: 10,
    }, {});
    const parsed = parseResult(r);
    expect(parsed.isError).toBe(true);
    expect(parsed.data.reason).toBe('unrelated');
    expect(parsed.data.hint).toMatch(/current handoff ownership chain/);
    expect(listForSessionCalls).toEqual([]);
  });

  it('rejects external callers even though the tool is read-only', async () => {
    const tools = await getTools({ transport: 'stdio' });
    const r = await tools.get('list_session_events').handler({
      callerSessionId: '__external__',
      sessionId: 'anything',
      limit: 10,
    }, {});
    const parsed = parseResult(r);
    expect(parsed.isError).toBe(true);
    expect(parsed.data.error).toMatch(/list_session_events not allowed for external caller/);
  });

  it('rejects missing targets before reading events', async () => {
    const tools = await getTools({ transport: 'http' });
    seedSession('caller');

    const r = await tools.get('list_session_events').handler({
      callerSessionId: 'caller',
      sessionId: 'ghost',
      limit: 10,
    }, {});
    const parsed = parseResult(r);
    expect(parsed.isError).toBe(true);
    expect(parsed.data.reason).toBe('target-not-found');
    expect(listForSessionCalls).toEqual([]);
  });

  it('does not treat inactive or archived team history as shared active visibility', async () => {
    const tools = await getTools({ transport: 'http' });
    seedSession('caller');
    seedSession('old-peer');
    mockMembershipsBySession.set('caller', [{ teamId: 'old-team' }]);
    mockMembershipsBySession.set('old-peer', [{ teamId: 'old-team' }]);
    mockTeamsById.set('old-team', { name: 'old-team' });

    const r = await tools.get('list_session_events').handler({
      callerSessionId: 'caller',
      sessionId: 'old-peer',
      limit: 10,
    }, {});
    const parsed = parseResult(r);
    expect(parsed.isError).toBe(true);
    expect(parsed.data.reason).toBe('unrelated');
  });
});
