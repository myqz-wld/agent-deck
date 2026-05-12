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
import type { SessionRecord, AgentDeckMessage } from '@shared/types';
import { adapterRegistry } from '@main/adapters/registry';
import { loadSdk } from '@main/adapters/claude-code/sdk-loader';
import { sessionRepo } from '@main/store/session-repo';
import { agentDeckMessageRepo } from '@main/store/agent-deck-message-repo';
import { sessionManager } from '@main/session/manager';
import { agentDeckTeamRepo, TeamInvariantError } from '@main/store/agent-deck-team-repo';
import { getBundledAssetContent } from '@main/bundled-assets';
import { enqueueAgentDeckMessage } from '@main/teams/universal-message-watcher';
import { eventBus } from '@main/event-bus';
import {
  AGENT_DECK_TOOL_NAMES,
  EXTERNAL_CALLER_ALLOWED,
  EXTERNAL_CALLER_SENTINEL,
  type CallerContext,
} from './types';
// plan team-cohesion-fix-20260513 Phase B Step B6：wait_reply 重写为 messages 表 query 模型，
// 老 wait-reply-coordinator (events 流投影) 整文件作废，B6 删除前先在 import 移除引用。
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
 * SessionRecord → metadata 投影。**list_sessions / get_session 共用同一份 projector**
 * （REVIEW_28 reviewer-codex LOW-2 修法）：避免 get_session 暴露 raw SessionRecord 引入额外
 * metadata；future visibility predicate 加在这一层即可两 tool 同步生效。
 *
 * D3 (CHANGELOG_76 / plan deep-review-flow-fix): teamName 从 universal team backend
 * members 表反查（R3 真源），不再只读老 sessions.team_name 列（注释明示「R3 不再消费此列」）。
 * 修「lead session spawn_session 后自身 teamName 仍 null」不对称 bug：
 *  - teammate spawn 时 sessionManager.recordCreatedTeamName 写过 sessions.team_name
 *  - 但 lead 自己只 addMember 没 recordCreatedTeamName，sessions.team_name 是 null
 *  - projectSession 从 members 反查后 lead 也能投影到正确 teamName
 * 单 query 走 indexed (session_id) lookup 是 ms 级；list 默认 limit 50 → N+1 仍 < 10ms 可接受，
 * 没必要先优化批量。多 team 共享时取第一个 active team（teamName 字段语义是「展示用」非路由
 * 标识；路由用 spawn 时显式 args.team_name / send_message 显式 team_id）。
 */
/**
 * SessionRecord → metadata 投影。**list_sessions / get_session 共用同一份 projector**
 * （REVIEW_28 reviewer-codex LOW-2 修法）：避免 get_session 暴露 raw SessionRecord 引入额外
 * metadata；future visibility predicate 加在这一层即可两 tool 同步生效。
 *
 * plan team-cohesion-fix-20260513 Phase A Step A7：直接消费 enriched `s.teams` 字段
 * （由 sessionManager.enrichWithTeams / enrichWithTeamsBatch 注入），不再 N+1 反查。
 * 调用方必须传 enriched SessionRecord（list_sessions / get_session handler 已切到
 * sessionManager facade 路径保证 enriched）。teamName 取 teams[0]?.teamName 与 SessionCard 一致。
 *
 * 多 team 共享时取第一个（teamName 字段语义是「展示用」非路由标识；路由用 spawn 时
 * 显式 args.team_name / send_message 显式 team_id）。新增 teams 完整数组字段方便
 * caller 自行查多 team 共享场景。
 */
function projectSession(s: SessionRecord) {
  return {
    sessionId: s.id,
    adapter: s.agentId,
    cwd: s.cwd,
    lifecycle: s.lifecycle,
    title: s.title,
    lastEventAt: s.lastEventAt,
    teamName: s.teams?.[0]?.teamName ?? null,
    teams: s.teams ?? [],
    spawnedBy: s.spawnedBy ?? null,
    spawnDepth: s.spawnDepth ?? 0,
  };
}

/**
 * 6 个 tool 的 zod schema 集中地。三 transport 共享同一份 schema。
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
  /**
   * 可选 plugin agent body 自动注入（CHANGELOG_76 / plan deep-review-flow-fix D1）：
   * 非空时 in-process / HTTP / stdio handler 都会按 plugin agents registry 找 body file
   * (`<resources>/claude-config/agent-deck-plugin/agents/<name>.md` 经 bundled-assets 缓存)，
   * 把 body 内容作为 caller `prompt` 的前缀注入。免去 lead 自己 cat body 拼字符串。
   * 找不到 / 不是合法 plugin agent name → spawn_session 直接返回 err（避免静默落空 fallback）。
   * 仅 claude-code adapter 有意义；其他 adapter 也允许传但行为相同（adapter 自己决定怎么用）。
   */
  agent_name: z
    .string()
    .min(1)
    .max(128)
    .regex(/^[a-zA-Z0-9._-]+$/, 'agent_name only allows [a-zA-Z0-9._-]')
    .optional()
    .describe(
      'Optional plugin agent name (e.g. "reviewer-claude" / "reviewer-codex"). When set, the agent body is auto-prepended to `prompt` from bundled-assets registry, so callers do not need to cat & embed the body themselves. Errors when name does not resolve to a known plugin agent.',
    ),
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
  // plan team-cohesion-fix-20260513 Phase B Step B2：可选对话链关联
  reply_to_message_id: z
    .string()
    .min(1)
    .max(128)
    .optional()
    .describe(
      'Optional: link this message as a reply to an existing message in the same team. The reply forms a conversation chain queryable via wait_reply({message_id}). Use this for "I am replying to message X" semantics; for new topics omit it. The dedicated reply_message tool is a more ergonomic alias that auto-resolves to_session_id and team_id from the original message.',
    ),
};

const WAIT_REPLY_SCHEMA = {
  // plan team-cohesion-fix-20260513 Phase B Step B4：wait_reply 重定义为「等某条 msg 的 reply」
  // —— 不再是事件流投影，直接 query messages 表 + universal-message-watcher event listener。
  message_id: z
    .string()
    .min(1)
    .max(128)
    .describe(
      'Wait for a reply to this specific message id (returned by send_message / reply_message). The wait resolves when a message with reply_to_message_id = this id is delivered (DB query + event listener).',
    ),
  nudge_text: z
    .string()
    .min(1)
    .max(100_000)
    .optional()
    .describe(
      'Optional: if no reply arrives within nudge_after_ms, automatically send a nudge message (text body) to the recipient as a "are you there" reminder. The nudge is itself a reply to the original message (reply_to_message_id chains). Useful when the other side may have forgotten to call reply_message.',
    ),
  nudge_after_ms: z
    .number()
    .int()
    .min(5_000)
    .max(600_000)
    .optional()
    .describe(
      'How long (ms) to wait before sending the nudge. Defaults to half of timeout_ms (clamped 5_000 ~ 600_000). Ignored when nudge_text is omitted.',
    ),
  timeout_ms: z
    .number()
    .int()
    .min(1_000)
    .max(600_000)
    .default(600_000)
    .describe(
      'Total timeout. Returns { reply: null, timedOut: true } when exceeded.',
    ),
  caller_session_id: z.string().min(1).max(128),
};

const REPLY_MESSAGE_SCHEMA = {
  reply_to_message_id: z
    .string()
    .min(1)
    .max(128)
    .describe(
      'The id of the original message you are replying to (returned by send_message / wait_reply).',
    ),
  text: z.string().min(1).max(100_000).describe('Reply body (1-100KB).'),
  caller_session_id: z.string().min(1).max(128),
};

const LIST_SESSIONS_SCHEMA = {
  caller_session_id: z.string().min(1).max(128),
  status_filter: z.enum(['active', 'dormant', 'closed', 'all']).default('active'),
  adapter_filter: z
    .enum(['claude-code', 'codex-cli', 'aider', 'generic-pty'])
    .optional(),
  spawned_by_filter: z
    .string()
    .min(1)
    .max(128)
    .optional()
    .describe(
      'Filter to sessions whose spawnedBy === this id. Useful for lead → list children pattern (e.g. deep-code-review SKILL recovers stranded reviewer teammates after lead context reset). No ownership enforcement: any caller can query any spawnedBy id, consistent with list_sessions current single-user app-wide trust model.',
    ),
  limit: z.number().int().min(1).max(200).default(50),
};

const GET_SESSION_SCHEMA = {
  caller_session_id: z.string().min(1).max(128),
  session_id: z.string().min(1).max(128),
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
    'Spawn a new agent session via the given adapter (claude-code / codex-cli / aider / generic-pty). Returns the new sessionId. Subject to depth / per-parent fan-out / per-app rate-limit (see Agent Deck Settings → MCP Server). caller_session_id is required (in-process transport overrides with the real session id).',
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

      // 完整防递归 3 条规则（ADR §6 / REVIEW_28 移除 §6.2 cwd cycle 后）：depth 上限 /
      // fan-out / spawn-rate（顺序：不消耗资源的检查前置，详 spawn-guards.ts 头注释）。
      // 任一 deny 立即返回；通过 → 拿到 fanOutSlot，必须在 createSession 完成后（无论成功
      // 失败）调 release()。
      const guard = applySpawnGuards(caller, args.cwd, args.adapter);
      if ('isError' in guard) return guard;
      const { parentDepth, fanOutSlot } = guard;

      // D1 (CHANGELOG_76): agent_name 非空 → 按 plugin agents registry resolve body file，
      // 把 body 作为 prompt 前缀注入。getBundledAssetContent('agent', name) 已 startup 时
      // loadBundledAssets 预热缓存（main/index.ts:202 step 8.5），现读 fs 一次性拿到。
      // 找不到（拼写错 / 没安装该 plugin）→ 直接 err 防止静默落空 fallback。
      let promptToUse = args.prompt;
      if (args.agent_name) {
        const body = getBundledAssetContent('agent', args.agent_name);
        if (body === null) {
          fanOutSlot.release();
          return err(
            `agent body not found for agent_name="${args.agent_name}"`,
            'Plugin agent registry does not include this name. Check Header → 📚 资产库 → Agents tab for available bundled agent names (e.g. "reviewer-claude" / "reviewer-codex"). Spawn aborted to avoid silently falling back to caller prompt without the agent body.',
          );
        }
        // 拼接：body 在前 + 1 行空行分隔 + caller prompt 在后（task body 部分）。
        // 与 SDK system prompt 注入路径不同 —— in-process / HTTP / stdio 都没法直接改 SDK
        // system prompt prefix（adapter API 没暴露 additionalSystemPrompt），所以在
        // user-message 头部注入是最简兼容方案。reviewer-* agent body 顶部已有 frontmatter，
        // body 本身就是给 reviewer 看的「角色提示」，作为 user message 头部仍能起到 priming 作用。
        promptToUse = `${body}\n\n---\n\n${args.prompt}`;
      }

      // 实际 spawn
      let sid: string;
      try {
        sid = await adapter.createSession({
          cwd: args.cwd,
          prompt: promptToUse,
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
              // plan team-cohesion-fix-20260513 Phase A：lead addMember 后触发 session-upserted
              // 让桥点 enrich teams[] → renderer 立即看到 lead 的 🛡 chip（不再等下一个 agent event）。
              sessionManager.notifyTeamMembershipChanged(caller.callerSessionId);
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
          // plan team-cohesion-fix-20260513 Phase A Step A7：teammate addMember 后同样触发 session-upserted
          // 让桥点 enrich teams[]（与 lead 路径对称）。
          sessionManager.notifyTeamMembershipChanged(sid);
          // plan team-cohesion-fix-20260513 Phase A Step A8：删 sessionManager.recordCreatedTeamName 调用
          // —— universal team backend addMember 已是 SSOT，不再写老 sessions.team_name 列；
          // v012 migration 后此列彻底 drop。
        } catch (e) {
          console.warn(`[mcp spawn_session] team ensure / addMember failed for "${args.team_name}":`, e);
        }
      }

      // plan team-cohesion-fix-20260513 Phase B5：spawn 路径与 wait_reply 贯通的方案 A 实现 ——
      // spawn 仍把 prompt 给 adapter（SDK streaming 协议要求 first user message），同时在
      // messages 表 enqueue 一条 placeholder message（body=promptToUse, status='delivered'，
      // 不重复投递）作为 lead/teammate 对话链的锚点。lead 拿 spawnPromptMessageId 调
      // wait_reply({message_id})，teammate first turn 完成后调 reply_message(spawnPromptMessageId)
      // 回复，链路统一。无 team / no-shared-team 时不入队 placeholder（spawn 没有可关联的对话场景）。
      let spawnPromptMessageId: string | null = null;
      if (teamId && callerExists) {
        try {
          const placeholder = agentDeckMessageRepo.insert({
            teamId,
            fromSessionId: caller.callerSessionId,
            toSessionId: sid,
            body: promptToUse,
            replyToMessageId: null,
          });
          // 立即 mark delivered：SDK 已通过 createSession.prompt 收过这条 prompt，watcher 不需重投
          agentDeckMessageRepo.markDelivered(placeholder.id, Date.now());
          spawnPromptMessageId = placeholder.id;
        } catch (e) {
          // placeholder enqueue 失败不阻塞 spawn 成功（lead 可走老路径不 wait reply）
          console.warn(`[mcp spawn_session] placeholder message enqueue failed:`, e);
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
        // plan team-cohesion-fix-20260513 Phase B5：lead 用此 messageId 调 wait_reply 等 teammate first reply
        spawnPromptMessageId,
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
      // plan team-cohesion-fix-20260513 Phase B Step B2：透传 reply_to_message_id 建对话链
      const result = enqueueAgentDeckMessage({
        teamId,
        fromSessionId: caller.callerSessionId,
        toSessionId: args.session_id,
        body: args.text,
        replyToMessageId: args.reply_to_message_id ?? null,
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
        replyToMessageId: result.message.replyToMessageId,
        sentAt: result.message.sentAt,
        queued: true,
      });
    },
  );

  // ──────────────────── reply_message (plan team-cohesion-fix-20260513 Phase B Step B3 语法糖)
  const replyMessage = tool(
    AGENT_DECK_TOOL_NAMES.replyMessage,
    'Reply to an existing message in the same team. Convenience wrapper around send_message: auto-resolves to_session_id (= original message.from_session_id) and team_id (= original message.team_id), and sets reply_to_message_id automatically. Use this when you (lead or teammate) received a message and want to respond — the wait_reply tool on the other side will resolve once your reply is delivered. Returns immediately after queueing.',
    REPLY_MESSAGE_SCHEMA,
    async (args) => {
      const caller = deriveCaller(args);
      const denial = denyExternalIfNotAllowed('reply_message', caller);
      if (denial) return denial;
      const callerCheck = validateExternalCaller(caller);
      if (callerCheck) return callerCheck;

      // 反查原 msg
      const original = agentDeckMessageRepo.get(args.reply_to_message_id);
      if (!original) {
        return err(
          `original message ${args.reply_to_message_id} not found`,
          'reply_to_message_id must point to an existing message. Use list_messages or wait_reply to discover live message ids.',
        );
      }
      // 安全：caller 必须是原 msg 的 to_session_id（你只能回复给你的 msg）
      if (original.toSessionId !== caller.callerSessionId) {
        return err(
          'cannot reply: caller is not the recipient of the original message',
          `Original message was sent to ${original.toSessionId.slice(0, 8)}, but caller is ${caller.callerSessionId.slice(0, 8)}. You can only reply to messages addressed to you.`,
        );
      }
      // 自动算 to (= 原 msg 的 from) + team
      const toSessionId = original.fromSessionId;
      const teamId = original.teamId;
      // 防御：原 from 仍在 sessions 表 + lifecycle 不是 closed
      const target = sessionRepo.get(toSessionId);
      if (!target) {
        return err(`reply target session ${toSessionId} not found (original sender no longer exists)`);
      }
      if (target.lifecycle === 'closed') {
        return err(
          `reply target session ${toSessionId} is closed`,
          'The original sender has been closed; reply cannot be delivered.',
        );
      }

      const result = enqueueAgentDeckMessage({
        teamId,
        fromSessionId: caller.callerSessionId,
        toSessionId,
        body: args.text,
        replyToMessageId: args.reply_to_message_id,
      });
      if (!result.ok) {
        return err(
          `${result.error} (retryAfterMs=${result.retryAfterMs})`,
          'Per-team rate limit exceeded. Retry after the indicated delay or raise mcpMessageRatePerTeamPerMin in Settings.',
        );
      }
      return ok({
        sessionId: toSessionId,
        teamId,
        messageId: result.message.id,
        replyToMessageId: args.reply_to_message_id,
        sentAt: result.message.sentAt,
        queued: true,
      });
    },
  );

  // ──────────────────── wait_reply
  const waitReply = tool(
    AGENT_DECK_TOOL_NAMES.waitReply,
    'Wait for a reply to a specific message id. Resolves when a message with reply_to_message_id = this id is delivered (DB query + universal-message-watcher event listener). Optionally sends a nudge_text after nudge_after_ms if no reply arrives — useful when the recipient may have forgotten to call reply_message. Returns { reply: { messageId, text, sentAt, fromSessionId } | null, nudgesSent, timedOut }.',
    WAIT_REPLY_SCHEMA,
    async (args) => {
      const caller = deriveCaller(args);
      const denial = denyExternalIfNotAllowed('wait_reply', caller);
      if (denial) return denial;
      const callerCheck = validateExternalCaller(caller);
      if (callerCheck) return callerCheck;

      // 反查原 msg 校验存在
      const original = agentDeckMessageRepo.get(args.message_id);
      if (!original) {
        return err(
          `original message ${args.message_id} not found`,
          'message_id must point to an existing message (returned by send_message / reply_message). Use list_messages to discover live ids.',
        );
      }

      // 防 race：注册 listener 之前先查一次，reply 可能已到（caller wait_reply 慢于 reply 到达）
      const replyProj = (msg: AgentDeckMessage) => ({
        messageId: msg.id,
        text: msg.body,
        sentAt: msg.sentAt,
        fromSessionId: msg.fromSessionId,
      });
      const existing = agentDeckMessageRepo.findRepliesByMessageId(args.message_id);
      if (existing.length > 0) {
        return ok({
          reply: replyProj(existing[0]),
          nudgesSent: 0,
          timedOut: false,
        });
      }

      // 监听 universal-message-watcher 入队事件 + 状态变更事件，filter replyToMessageId
      let resolved = false;
      let nudgesSent = 0;
      let nudgeTimer: NodeJS.Timeout | null = null;
      let timeoutTimer: NodeJS.Timeout | null = null;
      let unsubscribeEnq: (() => void) | null = null;
      let unsubscribeChange: (() => void) | null = null;

      const cleanup = () => {
        if (nudgeTimer) clearTimeout(nudgeTimer);
        if (timeoutTimer) clearTimeout(timeoutTimer);
        if (unsubscribeEnq) unsubscribeEnq();
        if (unsubscribeChange) unsubscribeChange();
      };

      return new Promise((resolve) => {
        const checkReply = () => {
          if (resolved) return;
          const replies = agentDeckMessageRepo.findRepliesByMessageId(args.message_id);
          if (replies.length > 0) {
            resolved = true;
            cleanup();
            resolve(ok({
              reply: replyProj(replies[0]),
              nudgesSent,
              timedOut: false,
            }));
          }
        };

        const onEnqueued = (e: { id: string; teamId: string; fromSessionId: string; toSessionId: string }) => {
          // 任何 message-enqueued 触发都重 query 一次（filter 在 repo 层做更准确）
          if (e.teamId === original.teamId) checkReply();
        };
        const onChanged = (e: { id: string }) => {
          // status / cancellation 也可能影响 wait（cancelled reply 不算）
          if (e.id) checkReply();
        };
        unsubscribeEnq = eventBus.on('agent-deck-message-enqueued', onEnqueued);
        unsubscribeChange = eventBus.on('agent-deck-message-status-changed', onChanged);

        // nudge timer：nudge_text 非空时，nudge_after_ms 后 enqueue 一条催促消息
        if (args.nudge_text) {
          const nudgeDelay = args.nudge_after_ms ?? Math.max(5_000, Math.min(args.timeout_ms / 2, 600_000));
          nudgeTimer = setTimeout(() => {
            if (resolved) return;
            // 给原 msg 的接收方塞一条 nudge（reply_to_message_id 指向原 msg；fromSessionId 是 caller）
            try {
              enqueueAgentDeckMessage({
                teamId: original.teamId,
                fromSessionId: caller.callerSessionId,
                toSessionId: original.toSessionId,
                body: args.nudge_text!,
                replyToMessageId: args.message_id,
              });
              nudgesSent++;
            } catch (e) {
              console.warn('[mcp wait_reply] nudge enqueue failed:', e);
            }
          }, nudgeDelay);
        }

        // total timeout
        timeoutTimer = setTimeout(() => {
          if (resolved) return;
          resolved = true;
          cleanup();
          resolve(ok({
            reply: null,
            nudgesSent,
            timedOut: true,
          }));
        }, args.timeout_ms);
      });
    },
    { annotations: { readOnlyHint: false } }, // wait_reply 现在可能 enqueue nudge，不再纯 read-only
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
      // spawned_by_filter 在 slice(limit) 前执行（REVIEW_28 reviewer-codex INFO-1 修法），
      // 避免大 lead 反查少量 children 时被 limit cutoff 误报空列表。
      if (args.spawned_by_filter) {
        sessions = sessions.filter((s) => s.spawnedBy === args.spawned_by_filter);
      }
      const truncated = sessions.slice(0, args.limit);
      // plan team-cohesion-fix-20260513 Phase A Step A7：projectSession 不再自反查 universal
      // team backend，依赖 caller 传 enriched SessionRecord。这里在 slice 后 batch enrich
      // 一次（避免 list 整批 ≤ 100 sessions 各反查一次 N+1）。
      const enriched = sessionManager.enrichWithTeamsBatch(truncated);
      return ok({
        total: enriched.length,
        sessions: enriched.map(projectSession),
      });
    },
    { annotations: { readOnlyHint: true } },
  );

  // ──────────────────── get_session
  const getSession = tool(
    AGENT_DECK_TOOL_NAMES.getSession,
    "Get a single session metadata by id. Returns same projection as list_sessions (sessionId, adapter, cwd, lifecycle, title, lastEventAt, teamName, teams, spawnedBy, spawnDepth) — does NOT include events / messages (use wait_reply for those). Returns isError when session does not exist.",
    GET_SESSION_SCHEMA,
    async (args) => {
      const caller = deriveCaller(args);
      const denial = denyExternalIfNotAllowed('get_session', caller);
      if (denial) return denial;
      const callerCheck = validateExternalCaller(caller);
      if (callerCheck) return callerCheck;
      // plan team-cohesion-fix-20260513 Phase A Step A7：走 sessionManager.get（已 enrich）
      const session = sessionManager.get(args.session_id);
      if (!session) {
        return err(
          `session ${args.session_id} not found`,
          'session_id must reference an existing session. Use list_sessions to discover ids; pass status_filter:"all" to include closed sessions.',
        );
      }
      return ok(projectSession(session));
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

  return [spawnSession, sendMessage, replyMessage, waitReply, listSessions, getSession, shutdownSession];
}

// re-export internal helpers for B'2.b unit tests
export { ok as _internalOk, err as _internalErr };
