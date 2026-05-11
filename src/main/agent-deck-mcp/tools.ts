/**
 * Agent Deck MCP server 的 5 个 in-process tool 注册（B'0 ADR §3）。
 *
 * 本文件**仅**定义 zod schema 与 handler 实现核心（spawn / send / list / shutdown
 * 在 B'2.a 实现完整逻辑；wait_reply 在 B'2.b 单独实现）。三 transport（in-process /
 * HTTP / stdio）共享同一份 buildAgentDeckTools 输出；transport 层负责 caller-id
 * 注入策略（ADR §4 / types.ts CallerContext）。
 *
 * Closure 注入参数：
 * - sessionManager / adapterRegistry / sessionRepo（Skip：B'2.a 实现）
 * - rateLimiter（B'5 实现）
 * - waitReplyCoordinator（B'2.b 实现）
 *
 * 字段命名约定：tool args **snake_case**（与 task-manager 既有约定 + Python SDK
 * 惯例一致；与 spec 对齐方便 LLM 看到熟悉的 schema）；内部 TS 接口 camelCase。
 */

import { z } from 'zod';
import type { SdkMcpToolDefinition } from '@anthropic-ai/claude-agent-sdk';
import { loadSdk } from '@main/adapters/claude-code/sdk-loader';
import {
  AGENT_DECK_TOOL_NAMES,
  EXTERNAL_CALLER_ALLOWED,
  EXTERNAL_CALLER_SENTINEL,
  type CallerContext,
} from './types';

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
 * 5 个 tool 的 zod schema 集中地。三 transport 共享同一份 schema；handler 实现
 * 在 B'2.a / B'2.b 阶段补全。当前 B'1 仅返回「未实现」占位以让骨架可挂载。
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

/**
 * 构造 5 个 tool 注册（B'1 占位 / B'2 替换为完整实现）。
 *
 * B'1 的 5 个 handler 都返回「not implemented」isError，但 zod schema 完整 —— 这样
 * MCP client（claude / codex / inspector）已可以 list_tools 看到正确 shape，
 * 防递归 4 条规则（B'5）+ wait_reply coordinator（B'2.b）后续接入时只换 handler 不换 schema。
 */
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

  const spawnSession = tool(
    AGENT_DECK_TOOL_NAMES.spawnSession,
    'Spawn a new agent session via the given adapter (claude-code / codex-cli / aider / generic-pty). Returns the new sessionId. Subject to depth / cwd-cycle / per-app rate-limit / per-parent fan-out (see Agent Deck Settings → MCP Server). caller_session_id is required (in-process transport overrides with the real session id).',
    SPAWN_SESSION_SCHEMA,
    async (args) => {
      const caller = deriveCaller(args);
      const denial = denyExternalIfNotAllowed('spawn_session', caller);
      if (denial) return denial;
      // B'2.a 实现：rate-limit / depth / cwd cycle / fan-out / setSpawnLink reserve / createSession
      return err(
        'spawn_session: not implemented (B\'2.a)',
        'Tool registration scaffolded by B\'1; full handler arrives in B\'2.a.',
      );
    },
  );

  const sendMessage = tool(
    AGENT_DECK_TOOL_NAMES.sendMessage,
    'Send a user message to an existing session. Returns immediately after queueing — use wait_reply to observe the response.',
    SEND_MESSAGE_SCHEMA,
    async (args) => {
      const caller = deriveCaller(args);
      const denial = denyExternalIfNotAllowed('send_message', caller);
      if (denial) return denial;
      return err(
        'send_message: not implemented (B\'2.a)',
        'Tool registration scaffolded by B\'1; full handler arrives in B\'2.a.',
      );
    },
  );

  const waitReply = tool(
    AGENT_DECK_TOOL_NAMES.waitReply,
    'Wait for the next reply from a session. until: first_message (first assistant text), turn_complete (finished/waiting-for-user event), idle (N seconds quiet, default 5s — tuned by Settings, recommend turn_complete for high-reasoning models). Returns partial events on timeout.',
    WAIT_REPLY_SCHEMA,
    async (args) => {
      const caller = deriveCaller(args);
      const denial = denyExternalIfNotAllowed('wait_reply', caller);
      if (denial) return denial;
      return err(
        'wait_reply: not implemented (B\'2.b)',
        'Tool registration scaffolded by B\'1; full handler arrives in B\'2.b (coordinator + backfill).',
      );
    },
    { annotations: { readOnlyHint: true } },
  );

  const listSessions = tool(
    AGENT_DECK_TOOL_NAMES.listSessions,
    "List currently visible sessions (read-only). Returns metadata (sessionId, adapter, cwd, lifecycle, title, lastEventAt, teamName, spawnedBy, spawnDepth) — does NOT include events / messages (use wait_reply for those).",
    LIST_SESSIONS_SCHEMA,
    async (args) => {
      const caller = deriveCaller(args);
      const denial = denyExternalIfNotAllowed('list_sessions', caller);
      if (denial) return denial;
      return err(
        'list_sessions: not implemented (B\'2.a)',
        'Tool registration scaffolded by B\'1; full handler arrives in B\'2.a.',
      );
    },
    { annotations: { readOnlyHint: true } },
  );

  const shutdownSession = tool(
    AGENT_DECK_TOOL_NAMES.shutdownSession,
    "Mark a session as closed (lifecycle=closed) + abort its SDK live query. Does NOT delete events / file_changes / summaries — they remain queryable. caller cannot shutdown self.",
    SHUTDOWN_SESSION_SCHEMA,
    async (args) => {
      const caller = deriveCaller(args);
      const denial = denyExternalIfNotAllowed('shutdown_session', caller);
      if (denial) return denial;
      if (args.session_id === caller.callerSessionId) {
        return err(
          'cannot shutdown self',
          'Use the application UI / IPC to terminate your own session.',
        );
      }
      return err(
        'shutdown_session: not implemented (B\'2.a)',
        'Tool registration scaffolded by B\'1; full handler arrives in B\'2.a.',
      );
    },
  );

  return [spawnSession, sendMessage, waitReply, listSessions, shutdownSession];
}

// re-export internal helpers for B'2.a / B'2.b unit tests
export { ok as _internalOk, err as _internalErr };
