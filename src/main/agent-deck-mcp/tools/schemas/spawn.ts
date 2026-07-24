import { z } from 'zod';
import { SESSION_THINKING_LEVELS } from '@shared/session-metadata';
import { SDK_WRITE_CALLER_SESSION_ID_DESCRIPTION } from './shared';
import { MAX_USER_MESSAGE_LENGTH } from '@shared/message-limits';

export const SPAWN_SESSION_MODEL_VALUES = [
  'haiku',
  'sonnet',
  'opus',
  'fable',
  'gpt-5.6-sol',
  'gpt-5.6-terra',
  'gpt-5.6-luna',
  'gpt-5.5',
  'gpt-5.4',
  'v4-flash',
  'v4-pro',
  'grok-4.5',
] as const;
export type SpawnSessionModelValue = (typeof SPAWN_SESSION_MODEL_VALUES)[number];

export const SPAWN_SESSION_THINKING_VALUES = SESSION_THINKING_LEVELS;
export type SpawnSessionThinkingValue = (typeof SPAWN_SESSION_THINKING_VALUES)[number];

export const SPAWN_SESSION_SCHEMA = {
  adapter: z
    .enum(['claude-code', 'deepseek-claude-code', 'codex-cli', 'grok-build'])
    .describe(
      'Choose the adapter that runs the new session: "claude-code", "deepseek-claude-code", "codex-cli", or "grok-build". Fresh sessions may use a different adapter; contextMode "fork" requires a target adapter with native fork support.',
    ),
  cwd: z
    .string()
    .min(1)
    .max(4096)
    .refine(
      (p) => p.startsWith('/') || /^[A-Za-z]:[\\/]/.test(p),
      'Must be absolute path',
    )
    .describe(
      'Working directory for the new session. Must be an absolute path (e.g. /Users/.../repo or a worktree dir); relative paths are rejected. contextMode "fork" also requires this path and the caller cwd to resolve to the same real directory.',
    ),
  prompt: z
    .string()
    .min(1)
    .max(MAX_USER_MESSAGE_LENGTH)
    .describe(
      'First user message sent to the new session (the task / instructions). When `agentName` is omitted, the session is generic and receives this prompt plus the normal runtime baseline. When `agentName` is set, Agent Deck starts the target adapter with that agent through adapter-native fields and still sends this prompt as the task. For long context, write a file under /tmp and tell the spawned session to read it; this is a general prompt convention, not a special handoff feature.',
    ),
  contextMode: z
    .enum(['fresh', 'fork'])
    .optional()
    .describe(
      'Optional provider-context policy. Omit or set "fresh" for the existing context-free spawn. Set "fork" to natively fork only the authenticated caller: target adapter must exactly match the caller and target cwd must resolve to the same real directory. The child receives prior provider history plus the current user request, while the caller assistant\'s unfinished reasoning, output, tool use, and spawn_session call are excluded. A first-turn Codex fork creates an independent zero-prefix target thread and replays the current native UserInput values before the delegated prompt. No source session id or turn count is accepted. If native fork eligibility fails, correct the returned hint or use "fresh"; Agent Deck never silently downgrades a requested fork. A successful fork adds contextMode and forkedFromSessionId to the result.',
    ),
  teamName: z
    .string()
    .min(1)
    .max(128)
    .optional()
    .describe(
      'Optional team to form or reuse. Omit for a standalone session; standalone sessions can still exchange teamless DMs through send_message but do not appear together in TeamDetail. Set to make the caller a lead and the new session a teammate in that active team.',
    ),
  /**
   * Optional adapter-native agent selection. Claude-family targets use SDK `agent` + `agents`;
   * Codex targets parse official TOML custom-agent files and map supported config fields to
   * app-server thread/developerInstructions/config options. Unknown names reject.
   */
  agentName: z
    .string()
    .min(1)
    .max(128)
    .regex(/^[a-zA-Z0-9._-]+$/, 'agentName only allows [a-zA-Z0-9._-]')
    .optional()
    .describe(
      'Optional real agent name. Resolution is adapter-scoped: bundled Agent Deck reviewers first, then supported project/user agents. Claude starts with SDK agent/agents; Codex maps TOML developer_instructions and supported config fields; Grok Build selects a bundled plugin agent through ACP session metadata. For a normal/general-purpose spawned session, omit agentName and put complete instructions in prompt; use displayName only for labels. Unknown names reject.',
    ),
  model: z
    .string()
    .trim()
    .min(1)
    .max(256)
    .optional()
    .describe(
      'Optional model override for the spawned session only. Suggested values by adapter: Claude — haiku, sonnet, opus, fable; Codex — gpt-5.6-sol, gpt-5.6-terra, gpt-5.6-luna, gpt-5.5, gpt-5.4; Deepseek — v4-flash, v4-pro; Grok Build — grok-4.5. Suggestions are not an allowlist: any non-empty provider model id is passed to the target provider for validation. Precedence: explicit model > resolved agent model > provider default.',
    ),
  thinking: z
    .enum(SPAWN_SESSION_THINKING_VALUES)
    .optional()
    .describe(
      'Optional thinking/reasoning override for the spawned session only. Precedence: explicit thinking > resolved agent effort > provider default. Grok Build accepts low, medium, high, and xhigh; Codex accepts low through ultra; Claude and Deepseek accept low, medium, high, xhigh, and max. Adapter-invalid values are rejected before session creation.',
    ),
  /**
   * REVIEW_31 Bug 4：teammate 显示名（覆盖 session.title 默认 cwd-basename）。
   * UI 列表 / SessionCard / TeamDetail / wire format wireBody 全走 displayName 优先级链
   * （argument > agentName > 默认 cwd-basename）—— 解决"多 reviewer 都显示同一个 cwd 区分不出"的体验问题。
   */
  displayName: z
    .string()
    .min(1)
    .max(80)
    .optional()
    .describe(
      'Optional human-readable display name for the spawned session (e.g. "reviewer-claude · batch A", "patch-coder", "prompt-editor"). Use this for naming a generic teammate; do not set `agentName` just to label the session. When omitted, falls back to agentName (if set), otherwise cwd-basename. Becomes session.title (visible in SessionList / TeamDetail) and team_member.displayName (visible in wire format prefix).',
    ),
  permissionMode: z
    .enum(['default', 'acceptEdits', 'plan', 'bypassPermissions'])
    .optional()
    .describe(
      'Explicit permission-mode override for a spawned Claude-family session. Omit unless the user explicitly requests it. It is incompatible with codex-cli and grok-build.',
    ),
  sessionMode: z
    .enum(['default', 'plan', 'ask'])
    .optional()
    .describe(
      'Grok Build work mode for the spawned session: default executes normally, plan plans without normal execution, and ask is conversational. It is distinct from Claude permissionMode and incompatible with other adapters.',
    ),
  codexSandbox: z
    .enum(['workspace-write', 'read-only', 'danger-full-access'])
    .optional()
    .describe(
      'Explicit sandbox override for a codex-cli spawned session, including bundled reviewer agents. Omit unless the user explicitly requests this sandbox mode; omitted values let Agent Deck inherit from a same-adapter codex caller or use the codex adapter default.',
    ),
  claudeCodeSandbox: z
    .enum(['off', 'workspace-write', 'strict'])
    .optional()
    .describe(
      'Explicit OS sandbox override for a claude-code or deepseek-claude-code spawned session. Omit unless the user explicitly requests this sandbox mode; omitted values let Agent Deck inherit from a same-adapter caller or use the target adapter default.',
    ),
  /**
   * 可选额外 writable roots（仅 claude-code adapter + workspace-write 档生效）。
   * 目标 Claude session 需要写 cwd 外路径时传；same-adapter spawn 会继承 caller 既有值。
   */
  extraAllowWrite: z
    .array(z.string().min(1).max(4096))
    .max(16)
    .optional()
    .describe(
      'Extra writable roots for a claude-code workspace-write sandbox. Use only when the spawned Claude-family session must edit paths outside cwd.',
    ),
  callerSessionId: z
    .string()
    .min(1)
    .max(128)
    .optional()
    .describe(SDK_WRITE_CALLER_SESSION_ID_DESCRIPTION),
  parentSessionId: z
    .string()
    .min(1)
    .max(128)
    .optional()
    .describe('Internal spawn-link plumbing; direct callers leave unset so the handler uses the caller as parent.'),
};

const SPAWN_SESSION_FRESH_ONLY_SCHEMA = {
  ...SPAWN_SESSION_SCHEMA,
  contextMode: z
    .literal('fresh')
    .optional()
    .describe(
      'This caller adapter does not provide native context fork. Omit contextMode or set "fresh". To preserve work across adapters, use hand_off_session with an explicit continuation prompt.',
    ),
};

/**
 * Keep spawn_session available for cross-adapter fresh teammates while removing an impossible
 * native-fork value from callers whose runtime profile cannot implement it.
 */
export function spawnSessionSchemaForCaller(canForkSession: boolean | null) {
  return canForkSession === false
    ? SPAWN_SESSION_FRESH_ONLY_SCHEMA
    : SPAWN_SESSION_SCHEMA;
}

export type SpawnSessionArgs = z.infer<z.ZodObject<typeof SPAWN_SESSION_SCHEMA>>;

/** spawn_session guard limits exposed to callers on success and guard-deny paths. */
export interface SpawnSessionLimits {
  depth: {
    /** Caller session depth before this spawn. */
    current: number;
    /** Spawned session depth on success, or the normal-spawn attempted next depth on guard deny. */
    next: number;
    max: number;
  };
  fanOut: {
    /** Active children plus in-flight spawn reservations for this caller. */
    current: number;
    activeChildren: number;
    inFlight: number;
    max: number;
  };
  rate: {
    /** Used spawn tokens in the current sliding window. */
    current: number;
    max: number;
    windowMs: number;
    retryAfterMs: number;
  };
}

/** spawn_session ok return shape（spawn.ts handler；hand-off-session 通过 extends 复用全部字段）。 */
export interface SpawnSessionResult {
  sessionId: string;
  adapter: string;
  cwd: string;
  teamId: string | null;
  teamName: string | null;
  agentName: string | null;
  /** displayName 优先 → agentName → null（spawn.ts:163 三级 fallback）。 */
  displayName: string | null;
  spawnDepth: number;
  spawnLimits: SpawnSessionLimits;
  sentAt: number;
  spawnPromptMessageId: string | null;
  /** Present only when the caller explicitly requested a successful native provider fork. */
  contextMode?: 'fork';
  /** Authenticated Agent Deck caller id; provider-native ids are never returned here. */
  forkedFromSessionId?: string;
}
