/**
 * Agent Deck MCP server 的 5 个 in-process tool 注册（B'0 ADR §3）。
 *
 * 三 transport（in-process / HTTP / stdio）共享同一份 buildAgentDeckTools 输出；
 * transport 层负责 caller-id 注入策略：
 * - in-process（B'3）：closure 强制覆盖 args.caller_session_id（防 prompt 注入伪造）
 * - HTTP/stdio：args.caller_session_id 必填，handler 内反查 sessionManager
 *
 * Handler 实现状态：
 * - spawn / send / list / shutdown：B'2.a 完整逻辑（本 commit）
 * - wait_reply：仍 placeholder，B'2.b 接 WaitReplyCoordinator 后实现
 *
 * 防递归（B'0 ADR §6）：当前 B'2.a 仅做最基础的 self-spawn 1 层 cycle 检测；
 * 完整 4 条规则（depth / fan-out / spawn-rate / 整链回溯）放 B'5 接入 RateLimiter
 * + Race Protection mutex 时一并落地。
 *
 * 字段命名约定：tool args **snake_case**（与 task-manager 既有约定一致），
 * 内部 TS 接口 camelCase。
 */

import { z } from 'zod';
import type { SdkMcpToolDefinition } from '@anthropic-ai/claude-agent-sdk';
import type { SessionRecord } from '@shared/types';
import { adapterRegistry } from '@main/adapters/registry';
import { loadSdk } from '@main/adapters/claude-code/sdk-loader';
import { sessionRepo } from '@main/store/session-repo';
import { eventRepo } from '@main/store/event-repo';
import { sessionManager } from '@main/session/manager';
import { settingsStore } from '@main/store/settings-store';
import { agentDeckTeamRepo, TeamInvariantError } from '@main/store/agent-deck-team-repo';
import { enqueueAgentDeckMessage } from '@main/teams/universal-message-watcher';
import {
  AGENT_DECK_TOOL_NAMES,
  EXTERNAL_CALLER_ALLOWED,
  EXTERNAL_CALLER_SENTINEL,
  type CallerContext,
} from './types';
import {
  waitReplyCoordinator,
  type EventProjection,
} from './wait-reply-coordinator';
import { applySpawnGuards } from './spawn-guards';

/**
 * Tool handler 共用：把 zod 解析后的 caller_session_id（args 字段）规范为
 * CallerContext。in-process transport 在外层 wrapper 内会**再次**用 closure
 * 覆盖 callerSessionId（强制语义防 prompt 注入伪造）。
 */
export function makeCallerContext(
  rawCallerSid: string,
  rawParentSid: string | undefined,
  transport: CallerContext['transport'],
): CallerContext {
  return {
    callerSessionId: rawCallerSid,
    parentSessionId: rawParentSid ?? rawCallerSid,
    transport,
  };
}

/**
 * external caller 防御：若工具不允许外部调用且 caller = `__external__`，
 * 直接返回 isError，handler 不执行业务逻辑。
 */
export function denyExternalIfNotAllowed(
  toolName: keyof typeof EXTERNAL_CALLER_ALLOWED,
  caller: CallerContext,
): { content: { type: 'text'; text: string }[]; isError: true } | null {
  if (
    caller.callerSessionId === EXTERNAL_CALLER_SENTINEL &&
    !EXTERNAL_CALLER_ALLOWED[toolName]
  ) {
    return {
      content: [
        {
          type: 'text' as const,
          text: JSON.stringify({
            error: `tool ${toolName} not allowed for external caller (caller_session_id=__external__)`,
            hint: 'External MCP clients can only call read-only tools (list_sessions, wait_reply). To spawn / send / shutdown sessions, use the in-process or HTTP transport with a real caller_session_id.',
          }),
        },
      ],
      isError: true as const,
    };
  }
  return null;
}

function ok(data: unknown) {
  return {
    content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }],
  };
}

function err(message: string, hint?: string) {
  return {
    content: [
      {
        type: 'text' as const,
        text: JSON.stringify(hint ? { error: message, hint } : { error: message }),
      },
    ],
    isError: true as const,
  };
}

/**
 * caller 反查（HTTP/stdio transport 用；in-process 已通过 closure 强制覆盖跳过）：
 * - external caller（__external__）已被 denyExternalIfNotAllowed 拦下，不到这里
 * - in-process closure 覆盖后的 caller 也直接信任
 * - HTTP/stdio：args.caller_session_id 必须能反查到 sessionRepo 且未 closed
 *
 * 返回 null 表示通过；返回错误对象表示 deny。
 */
function validateExternalCaller(
  caller: CallerContext,
):
  | { content: { type: 'text'; text: string }[]; isError: true }
  | null {
  if (caller.transport === 'in-process') return null;
  if (caller.callerSessionId === EXTERNAL_CALLER_SENTINEL) return null;
  const session = sessionRepo.get(caller.callerSessionId);
  if (!session) {
    return err(
      `unknown caller_session_id: ${caller.callerSessionId}`,
      'caller_session_id must reference a session managed by Agent Deck. Use list_sessions to find valid session ids, or use the literal "__external__" for read-only access from non-Agent-Deck MCP clients.',
    );
  }
  if (session.lifecycle === 'closed') {
    return err(
      `caller_session_id ${caller.callerSessionId} is closed`,
      'Closed sessions cannot initiate new MCP tool calls. Open a new session via the application.',
    );
  }
  return null;
}

/**
 * 简化版 self-spawn cycle 检测已抽到 spawn-guards.ts 完整版（B'5），本处不再维护。
 */

/**
 * 5 个 tool 的 zod schema 集中地。三 transport 共享同一份 schema。
 */
const SPAWN_SESSION_SCHEMA = {
  adapter: z.enum(['claude-code', 'codex-cli', 'aider', 'generic-pty']),
  cwd: z
    .string()
    .min(1)
    .max(4096)
    .refine(
      (p) => p.startsWith('/') || /^[A-Za-z]:[\\/]/.test(p),
      'Must be absolute path',
    ),
  prompt: z.string().min(1).max(100_000),
  team_name: z.string().min(1).max(128).optional(),
  permission_mode: z
    .enum(['default', 'acceptEdits', 'plan', 'bypassPermissions'])
    .optional(),
  codex_sandbox: z
    .enum(['workspace-write', 'read-only', 'danger-full-access'])
    .optional(),
  caller_session_id: z.string().min(1).max(128),
  parent_session_id: z.string().min(1).max(128).optional(),
};

const SEND_MESSAGE_SCHEMA = {
  session_id: z.string().min(1).max(128),
  text: z.string().min(1).max(100_000),
  caller_session_id: z.string().min(1).max(128),
  // R3.E0 ADR §5.2 amend：multi-team 共享时必填，单 team 共享时可省（自动 resolve）
  team_id: z
    .string()
    .min(1)
    .max(128)
    .optional()
    .describe(
      'Team scope for this message. Required when caller and target share more than one active team; optional when sharing exactly one (auto-resolved). Reject when sharing zero teams.',
    ),
};

const WAIT_REPLY_SCHEMA = {
  session_id: z.string().min(1).max(128),
  until: z.enum(['first_message', 'turn_complete', 'idle']).default('idle'),
  timeout_ms: z.number().int().min(1000).max(600_000).default(60_000),
  since_ts: z.number().int().min(0).optional(),
  caller_session_id: z.string().min(1).max(128),
};

const LIST_SESSIONS_SCHEMA = {
  caller_session_id: z.string().min(1).max(128),
  status_filter: z.enum(['active', 'dormant', 'closed', 'all']).default('active'),
  adapter_filter: z
    .enum(['claude-code', 'codex-cli', 'aider', 'generic-pty'])
    .optional(),
  limit: z.number().int().min(1).max(200).default(50),
};

const SHUTDOWN_SESSION_SCHEMA = {
  session_id: z.string().min(1).max(128),
  caller_session_id: z.string().min(1).max(128),
  reason: z.string().max(500).optional(),
};

export interface BuildAgentDeckToolsDeps {
  /**
   * in-process transport 强制覆盖 caller_session_id 的 lazy provider；
   * HTTP / stdio transport 传 null（用 args.caller_session_id）。
   */
  callerSessionIdOverride: (() => string | null) | null;
  /** transport 类型，写入 CallerContext.transport 字段供 handler 决策。 */
  transport: CallerContext['transport'];
}

export async function buildAgentDeckTools(
  deps: BuildAgentDeckToolsDeps,
): Promise<SdkMcpToolDefinition<any>[]> {
  const { tool } = await loadSdk();
  const { transport, callerSessionIdOverride } = deps;

  function deriveCaller(args: {
    caller_session_id: string;
    parent_session_id?: string;
  }): CallerContext {
    const overridden = callerSessionIdOverride?.() ?? null;
    const callerSid = overridden ?? args.caller_session_id;
    return makeCallerContext(callerSid, args.parent_session_id, transport);
  }

  // ──────────────────── spawn_session
  const spawnSession = tool(
    AGENT_DECK_TOOL_NAMES.spawnSession,
    'Spawn a new agent session via the given adapter (claude-code / codex-cli / aider / generic-pty). Returns the new sessionId. Subject to depth / cwd-cycle / per-app rate-limit / per-parent fan-out (see Agent Deck Settings → MCP Server). caller_session_id is required (in-process transport overrides with the real session id).',
    SPAWN_SESSION_SCHEMA,
    async (args) => {
      const caller = deriveCaller(args);
      const denial = denyExternalIfNotAllowed('spawn_session', caller);
      if (denial) return denial;
      const callerCheck = validateExternalCaller(caller);
      if (callerCheck) return callerCheck;

      const adapter = adapterRegistry.get(args.adapter);
      if (!adapter || !adapter.createSession) {
        return err(
          `adapter "${args.adapter}" cannot create sessions`,
          'Adapter not registered or createSession not implemented. Check list_sessions to see available adapters.',
        );
      }
      if (!adapter.capabilities.canCreateSession) {
        return err(
          `adapter "${args.adapter}" does not support session creation`,
          'Some adapters (e.g. aider / generic-pty placeholders) are read-only.',
        );
      }

      // 完整防递归 4 条规则（B'5 / ADR §6）：depth 上限 / spawn-rate / fan-out / 整链
      // cwd cycle。任一 deny 立即返回；通过 → 拿到 fanOutSlot，必须在 createSession
      // 完成后（无论成功失败）调 release()。
      const guard = applySpawnGuards(caller, args.cwd, args.adapter);
      if ('isError' in guard) return guard;
      const { parentDepth, fanOutSlot } = guard;

      // 实际 spawn
      let sid: string;
      try {
        sid = await adapter.createSession({
          cwd: args.cwd,
          prompt: args.prompt,
          ...(args.permission_mode !== undefined ? { permissionMode: args.permission_mode } : {}),
          ...(args.codex_sandbox !== undefined ? { codexSandbox: args.codex_sandbox } : {}),
          ...(args.team_name !== undefined ? { teamName: args.team_name } : {}),
        });
      } catch (e) {
        fanOutSlot.release();
        return err(
          e instanceof Error ? e.message : String(e),
          'createSession failed; no session created. Check adapter logs for details.',
        );
      } finally {
        // 仅在 catch 路径已 release；finally 兜底 idempotent 二次 release（内部 dedupe）
        fanOutSlot.release();
      }

      // 持久化 spawn link / team 关联 / permission_mode（与 IPC adapters.ts handler 同款）
      // 仅当 caller 自身在 sessions 表里时记 spawn link（in-process 闭包外 caller 视为顶层）
      const callerExists = sessionRepo.get(caller.callerSessionId) !== null;
      if (callerExists) {
        sessionRepo.setSpawnLink(sid, caller.callerSessionId, parentDepth + 1);
      }
      if (adapter.capabilities.canSetPermissionMode && args.permission_mode) {
        sessionManager.recordCreatedPermissionMode(sid, args.permission_mode);
      }

      // R3.E0 ADR §5.1 amend：team_name 触发 universal team backend ensure-team-by-name
      // + 把 caller 加为 lead + 把新 session 加为 teammate（不再写 sessions.team_name 列）
      let teamId: string | null = null;
      if (args.team_name) {
        try {
          const team = agentDeckTeamRepo.ensureByName(args.team_name, { source: 'mcp' });
          teamId = team.id;
          // caller 自动以 lead role 加入（如已 active 则保留）。caller 不在 sessions 表
          // （external __external__ 等）时跳过。
          if (callerExists) {
            try {
              agentDeckTeamRepo.addMember({
                teamId: team.id,
                sessionId: caller.callerSessionId,
                role: 'lead',
                displayName: null,
              });
            } catch (e) {
              // 已 active 时 invariant 抛错；视为「已是 lead」幂等成功
              if (!(e instanceof TeamInvariantError)) throw e;
            }
          }
          agentDeckTeamRepo.addMember({
            teamId: team.id,
            sessionId: sid,
            role: 'teammate',
            displayName: null,
          });
          // 兼容老 sessions.team_name 列（不破坏 distinctTeamNames / findByTeamName 老 read 路径）
          // 但 R3 内 UI / 写路径都不再消费此列；下版本 v012 删
          sessionManager.recordCreatedTeamName(sid, args.team_name);
        } catch (e) {
          console.warn(`[mcp spawn_session] team ensure / addMember failed for "${args.team_name}":`, e);
        }
      }

      const created = sessionRepo.get(sid);
      return ok({
        sessionId: sid,
        adapter: args.adapter,
        cwd: args.cwd,
        teamId,
        teamName: args.team_name ?? null,
        spawnDepth: created?.spawnDepth ?? (callerExists ? parentDepth + 1 : 0),
        sentAt: Date.now(),
      });
    },
  );

  // ──────────────────── send_message
  const sendMessage = tool(
    AGENT_DECK_TOOL_NAMES.sendMessage,
    'Send a user message to an existing session. Routes through the universal-message-watcher (DB envelope + cross-adapter dispatch). Returns immediately after queueing — use wait_reply to observe the response. Multi-team callers must specify team_id.',
    SEND_MESSAGE_SCHEMA,
    async (args) => {
      const caller = deriveCaller(args);
      const denial = denyExternalIfNotAllowed('send_message', caller);
      if (denial) return denial;
      const callerCheck = validateExternalCaller(caller);
      if (callerCheck) return callerCheck;

      const target = sessionRepo.get(args.session_id);
      if (!target) {
        return err(`session ${args.session_id} not found`);
      }
      if (target.lifecycle === 'closed') {
        return err(
          `session ${args.session_id} is closed`,
          'Closed sessions cannot receive new messages. Spawn a new session if you need to continue.',
        );
      }
      if (caller.callerSessionId === args.session_id) {
        return err(
          'cannot send_message to self',
          'A session cannot post a message to its own user turn via MCP.',
        );
      }

      // R3.E0 ADR §5.2 amend：team_id resolve via shared active teams
      const sharedTeams = agentDeckTeamRepo.findSharedActiveTeams(
        caller.callerSessionId,
        args.session_id,
      );
      if (sharedTeams.length === 0) {
        return err(
          'no-shared-team',
          `caller (${caller.callerSessionId.slice(0, 8)}) and target (${args.session_id.slice(0, 8)}) are not in any common active team. Spawn the target via spawn_session({team_name: '...'}) or join an existing team via the application UI before sending messages.`,
        );
      }
      let teamId: string;
      if (args.team_id) {
        if (!sharedTeams.includes(args.team_id)) {
          return err(
            `team-not-shared: team_id ${args.team_id} is not in the shared active set [${sharedTeams.join(', ')}]`,
          );
        }
        teamId = args.team_id;
      } else if (sharedTeams.length === 1) {
        teamId = sharedTeams[0];
      } else {
        return err(
          'ambiguous-team',
          `caller and target share ${sharedTeams.length} active teams [${sharedTeams.join(', ')}]; pass team_id to disambiguate.`,
        );
      }

      // 入队（messageRateLimiter + repo.insert 100KB cap + self-message 防御都在内部）
      const result = enqueueAgentDeckMessage({
        teamId,
        fromSessionId: caller.callerSessionId,
        toSessionId: args.session_id,
        body: args.text,
      });
      if (!result.ok) {
        return err(
          `${result.error} (retryAfterMs=${result.retryAfterMs})`,
          'Per-team rate limit exceeded. Retry after the indicated delay or raise mcpMessageRatePerTeamPerMin in Settings.',
        );
      }
      return ok({
        sessionId: args.session_id,
        teamId,
        messageId: result.message.id,
        sentAt: result.message.sentAt,
        queued: true,
      });
    },
  );

  // ──────────────────── wait_reply
  const waitReply = tool(
    AGENT_DECK_TOOL_NAMES.waitReply,
    'Wait for the next reply from a session. until: first_message (first assistant text), turn_complete (finished/waiting-for-user event), idle (N seconds quiet, default 5s — tuned by Settings, recommend turn_complete for high-reasoning models). Returns partial events on timeout.',
    WAIT_REPLY_SCHEMA,
    async (args) => {
      const handlerEntryTs = Date.now();
      const caller = deriveCaller(args);
      const denial = denyExternalIfNotAllowed('wait_reply', caller);
      if (denial) return denial;
      const callerCheck = validateExternalCaller(caller);
      if (callerCheck) return callerCheck;

      const target = sessionRepo.get(args.session_id);
      if (!target) {
        return err(`session ${args.session_id} not found`);
      }
      // closed session 仍允许 wait（caller 可能想拉历史，超时即返）—— 不 deny

      const idleQuietMs = settingsStore.get('mcpWaitReplyIdleQuietMs') ?? 5000;
      const sinceTs = args.since_ts ?? handlerEntryTs;

      // 加入 coordinator（同 sessionId+until+idleQuietMs 共享 promise）
      const coordPromise = waitReplyCoordinator.waitFor(
        args.session_id,
        args.until,
        idleQuietMs,
      );

      // Race coordinator vs timeout（不 abort coordinator —— 让其他 caller 继续等）
      let timedOutTimer: NodeJS.Timeout | null = null;
      const timeoutPromise = new Promise<{ kind: 'timeout' }>((res) => {
        timedOutTimer = setTimeout(() => res({ kind: 'timeout' }), args.timeout_ms);
      });
      type RaceResult =
        | { kind: 'resolved'; value: Awaited<typeof coordPromise> }
        | { kind: 'timeout' };
      const wrappedCoord = coordPromise.then((value) => ({ kind: 'resolved' as const, value }));
      const raceResult: RaceResult = await Promise.race([wrappedCoord, timeoutPromise]);
      if (timedOutTimer) clearTimeout(timedOutTimer);

      let baselineTs: number;
      let liveEvents: EventProjection[];
      let timedOut = false;
      let reason: string;
      if (raceResult.kind === 'timeout') {
        // 超时：此时 coordinator 仍未 resolve；用 handlerEntryTs 当 baseline，live 为空。
        // backfill 由 handler 拉 [sinceTs, handlerEntryTs) 段补回 partial 事件给 caller。
        baselineTs = handlerEntryTs;
        liveEvents = [];
        timedOut = true;
        reason = 'timeout';
      } else {
        baselineTs = raceResult.value.baselineTs;
        liveEvents = raceResult.value.events;
        reason = raceResult.value.reason;
      }

      // Backfill：若 sinceTs < baselineTs 拉历史段，让多 caller 各自 since 切片
      // （reviewer 双对抗 HIGH-2 修法）
      let backfill: EventProjection[] = [];
      if (sinceTs < baselineTs) {
        try {
          const rows = eventRepo.listForSessionRange(args.session_id, sinceTs, baselineTs);
          backfill = rows.map((e) => {
            const proj: EventProjection = { kind: e.kind, ts: e.ts };
            // 简化投影：与 coordinator.projectEvent 同款（避免 cross-import 循环依赖）
            if (e.kind === 'message') {
              const p = e.payload as { text?: unknown } | null | undefined;
              if (p && typeof p.text === 'string') proj.text = p.text;
            }
            return proj;
          });
        } catch (e) {
          // backfill 失败不影响 live —— 只 warn
          console.warn(
            '[mcp wait_reply] backfill query failed, returning live events only:',
            e,
          );
        }
      }

      // 二次 filter：caller since_ts > baseline_ts 时也要剥离不感兴趣的 live 事件
      const filteredLive = liveEvents.filter((e) => e.ts > sinceTs);

      // 合并 backfill + filteredLive 按 ts ASC（backfill 已 ASC；filteredLive 也 ASC）
      const events = [...backfill, ...filteredLive];

      return ok({
        sessionId: args.session_id,
        until: args.until,
        timedOut,
        aborted: false, // 中断通过 SDK abortSignal 机制；当前 handler 不监听 abort 信号
        reason,
        events,
      });
    },
    { annotations: { readOnlyHint: true } },
  );

  // ──────────────────── list_sessions
  const listSessions = tool(
    AGENT_DECK_TOOL_NAMES.listSessions,
    "List currently visible sessions (read-only). Returns metadata (sessionId, adapter, cwd, lifecycle, title, lastEventAt, teamName, spawnedBy, spawnDepth) — does NOT include events / messages (use wait_reply for those).",
    LIST_SESSIONS_SCHEMA,
    async (args) => {
      const caller = deriveCaller(args);
      const denial = denyExternalIfNotAllowed('list_sessions', caller);
      if (denial) return denial;
      const callerCheck = validateExternalCaller(caller);
      if (callerCheck) return callerCheck;

      // 现有 sessionRepo API：
      // - status='active' 默认 → listActiveAndDormant().filter(lifecycle==='active')
      // - status='dormant' → listActiveAndDormant().filter(lifecycle==='dormant')
      // - status='closed' → listHistory({ archivedOnly:false }) 含 closed + archived
      // - status='all' → 合并去重
      // 注：此处用现有 API 拼装，避免新增 sessionRepo 通用 list({status,adapter,limit})
      // 接口（ADR §6.5.2 #6 实施清单建议加，但需要重构现有 47 个调用点 — 留 R2 收口或 R3）
      let sessions: SessionRecord[] = [];
      if (args.status_filter === 'active' || args.status_filter === 'dormant') {
        sessions = sessionRepo
          .listActiveAndDormant(args.limit * 2)
          .filter((s) => s.lifecycle === args.status_filter);
      } else if (args.status_filter === 'closed') {
        sessions = sessionRepo.listHistory({ limit: args.limit });
      } else {
        // 'all'
        const live = sessionRepo.listActiveAndDormant(args.limit);
        const closed = sessionRepo.listHistory({ limit: args.limit });
        sessions = [...live, ...closed];
      }
      if (args.adapter_filter) {
        sessions = sessions.filter((s) => s.agentId === args.adapter_filter);
      }
      const truncated = sessions.slice(0, args.limit);
      return ok({
        total: truncated.length,
        sessions: truncated.map((s) => ({
          sessionId: s.id,
          adapter: s.agentId,
          cwd: s.cwd,
          lifecycle: s.lifecycle,
          title: s.title,
          lastEventAt: s.lastEventAt,
          teamName: s.teamName ?? null,
          spawnedBy: s.spawnedBy ?? null,
          spawnDepth: s.spawnDepth ?? 0,
        })),
      });
    },
    { annotations: { readOnlyHint: true } },
  );

  // ──────────────────── shutdown_session
  const shutdownSession = tool(
    AGENT_DECK_TOOL_NAMES.shutdownSession,
    "Mark a session as closed (lifecycle=closed) + abort its SDK live query. Does NOT delete events / file_changes / summaries — they remain queryable. caller cannot shutdown self.",
    SHUTDOWN_SESSION_SCHEMA,
    async (args) => {
      const caller = deriveCaller(args);
      const denial = denyExternalIfNotAllowed('shutdown_session', caller);
      if (denial) return denial;
      const callerCheck = validateExternalCaller(caller);
      if (callerCheck) return callerCheck;
      if (args.session_id === caller.callerSessionId) {
        return err(
          'cannot shutdown self',
          'Use the application UI / IPC to terminate your own session.',
        );
      }
      const session = sessionRepo.get(args.session_id);
      if (!session) {
        return err(`session ${args.session_id} not found`);
      }
      if (session.lifecycle === 'closed') {
        // 已 closed，幂等返回 success（与 IPC delete 同模式：noop）
        return ok({ sessionId: args.session_id, lifecycle: 'closed', alreadyClosed: true });
      }
      try {
        await sessionManager.close(args.session_id);
      } catch (e) {
        return err(
          e instanceof Error ? e.message : String(e),
          'sessionManager.close failed; check main process logs for adapter close errors.',
        );
      }
      return ok({ sessionId: args.session_id, lifecycle: 'closed', alreadyClosed: false });
    },
  );

  return [spawnSession, sendMessage, waitReply, listSessions, shutdownSession];
}

// re-export internal helpers for B'2.b unit tests
export { ok as _internalOk, err as _internalErr };
