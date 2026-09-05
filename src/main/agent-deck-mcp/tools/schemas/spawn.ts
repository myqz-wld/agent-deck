import { z } from 'zod';
import { SESSION_THINKING_LEVELS } from '@shared/session-metadata';
import { MAX_USER_MESSAGE_LENGTH } from '@shared/message-limits';
import { MCP_TARGET_RUNTIME_SUPERSET_SHAPE } from './target-runtime';

export const SPAWN_SESSION_MODEL_VALUES = [
  'haiku',
  'sonnet',
  'opus',
  'fable',
  'gpt-6-astra',
  'gpt-5.6-sol',
  'gpt-5.6-terra',
  'gpt-5.6-luna',
  'grok-4.6',
  'grok-4.5',
] as const;

export const SPAWN_SESSION_THINKING_VALUES = SESSION_THINKING_LEVELS;
export type SpawnSessionThinkingValue = (typeof SPAWN_SESSION_THINKING_VALUES)[number];

const SPAWN_SESSION_AGENT_NAME_COMPONENT_MAX_LENGTH = 128;
export const SPAWN_SESSION_AGENT_NAME_MAX_LENGTH =
  SPAWN_SESSION_AGENT_NAME_COMPONENT_MAX_LENGTH * 2 + 1;
export const SPAWN_SESSION_EXPLICIT_DISPLAY_NAME_MAX_LENGTH = 80;
export const SPAWN_SESSION_RESULT_DISPLAY_NAME_MAX_LENGTH = Math.max(
  SPAWN_SESSION_AGENT_NAME_MAX_LENGTH,
  SPAWN_SESSION_EXPLICIT_DISPLAY_NAME_MAX_LENGTH,
);
const SPAWN_SESSION_AGENT_NAME_PATTERN = new RegExp(
  `^[a-zA-Z0-9._-]{1,${SPAWN_SESSION_AGENT_NAME_COMPONENT_MAX_LENGTH}}` +
    `(?::[a-zA-Z0-9._-]{1,${SPAWN_SESSION_AGENT_NAME_COMPONENT_MAX_LENGTH}})?$`,
);

export const SPAWN_SESSION_SCHEMA = {
  adapter: z
    .enum(['claude-code', 'codex-cli', 'grok-build'])
    .describe(
      'Required target adapter: "claude-code" (Claude Code), "codex-cli" (Codex CLI), or "grok-build" (Grok Build). Deepseek may name a Claude Gateway and xaminim may name a Codex Gateway; neither is an adapter. Fresh sessions may change adapter; contextMode "fork" requires the exact authenticated caller adapter and adapter-native runtime selector.',
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
      'Required target working directory, 1-4096 characters. It must use absolute POSIX or drive-letter syntax; relative paths are rejected. Provider creation can still reject a path that does not exist or is unreadable. contextMode "fork" additionally requires this path and the caller cwd to resolve to the same real directory.',
    ),
  prompt: z
    .string()
    .min(1)
    .max(MAX_USER_MESSAGE_LENGTH)
    .describe(
      'Required first user message, 1-102400 characters; whitespace-only text satisfies the schema but is not a useful delegation. Supply one self-contained, independently executable brief with the objective, exact scope and write set, exclusions, expected output, validation, and stop/report conditions. Keep tightly coupled producer/consumer files in one task and do not overlap another active worker. With no agentName, the target is generic; with agentName, adapter-native agent instructions are added and this remains the task. For long context, place a readable file in /tmp or the target worktree and name its absolute path.',
    ),
  contextMode: z
    .enum(['fresh', 'fork'])
    .optional()
    .describe(
      'Optional provider-context policy; omission defaults to "fresh". "fresh" starts without authenticated caller provider history and may change adapter or cwd. "fork" natively forks only the authenticated caller and requires an active, unarchived in-app SDK caller with a resumable native id, exact caller adapter, exact adapter-native runtime selector (Claude Gateway, Codex Gateway, or native default), native fork support, and cwd resolving to the same real directory. It accepts no source-session id or turn count. The child receives provider history plus current native user input through the safe active-turn boundary; it excludes the caller assistant\'s unfinished reasoning/output/tool use and this spawn_session frame. A first-turn Codex CLI fork uses an independent zero-prefix thread and replays current UserInput values before prompt. Fork failure never silently downgrades: follow the hint or retry with "fresh". Success adds contextMode:"fork" and forkedFromSessionId together.',
    ),
  teamName: z
    .string()
    .min(1)
    .max(128)
    .optional()
    .describe(
      'Optional active-team name, 1-128 characters with no trimming or normalization. Omit for a standalone session; it can still exchange teamless DMs through send_message but does not share active-team membership. When set, the authenticated caller must already have a durable Agent Deck session row; otherwise the request fails before team or provider creation. Preflight then creates or reuses the exact active name, requires the caller to be or become lead, and adds the target as teammate. Post-creation team setup participates in the tool contract’s reported rollback boundary.',
    ),
  /**
   * Optional adapter-native agent selection. Claude targets use SDK `agent` plus either
   * programmatic `agents` or a selected native Plugin root; Codex targets parse direct TOML agents
   * plus Agent Deck's Plugin `agents/*.toml` extension and map supported fields to app-server
   * thread/developerInstructions/config options; Grok targets pass the native profile through ACP.
   */
  agentName: z
    .string()
    .min(1)
    .max(SPAWN_SESSION_AGENT_NAME_MAX_LENGTH)
    .regex(
      SPAWN_SESSION_AGENT_NAME_PATTERN,
      'agentName allows a direct name or one plugin-qualified name like plugin-name:agent-name',
    )
    .optional()
    .describe(
      `Optional adapter-native agent selector: one 1-${SPAWN_SESSION_AGENT_NAME_COMPONENT_MAX_LENGTH} character name or plugin:name with each component 1-${SPAWN_SESSION_AGENT_NAME_COMPONENT_MAX_LENGTH} characters, using only letters, digits, dot, underscore, and hyphen. Resolution is adapter-scoped: bundled Agent Deck reviewers, then project direct/plugin agents, then user direct/plugin agents; unknown or ambiguous names reject before creation. Claude Code uses native Plugin Agent selection, Codex CLI supports the Agent Deck agents/*.toml extension, and Grok Build passes its native profile through ACP. Agent assets can contribute model/reasoning and adapter-native configuration; an app-owned bundled-Agent runtime override can select a Claude or Codex Gateway, and explicit public runtime fields win where exposed. A custom Codex Agent TOML model_provider remains in that Agent's thread configuration instead of becoming the public Gateway selector. A selected Codex agent configuration can affect sandbox, network, and readable/writable roots. The bundled reviewer-* identity itself grants no hidden elevation. Omit for a general teammate and use displayName only for a label.`,
    ),
  ...MCP_TARGET_RUNTIME_SUPERSET_SHAPE,
  /** Explicit human-readable label; the result may instead fall back to the longer agentName. */
  displayName: z
    .string()
    .min(1)
    .max(SPAWN_SESSION_EXPLICIT_DISPLAY_NAME_MAX_LENGTH)
    .optional()
    .describe(
      `Optional human-readable label, 1-${SPAWN_SESSION_EXPLICIT_DISPLAY_NAME_MAX_LENGTH} characters with no trimming. Use it to name a generic teammate; do not set agentName only for labeling. The target title uses displayName, then agentName, then cwd basename. The returned displayName is displayName, then agentName, then null, so it can be null even though the UI has a cwd-derived title.`,
    ),
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

/** Guard state, not a worker-capacity promise. Guard-deny errors return the same shape in text. */
export const SPAWN_SESSION_LIMITS_SCHEMA = z
  .object({
    depth: z
      .object({
        current: z.number().int().nonnegative().describe('Caller spawn depth before this request.'),
        next: z
          .number()
          .int()
          .nonnegative()
          .describe('Created target depth on success; attempted next depth on a guard denial.'),
        max: z.number().int().nonnegative().describe('Configured maximum normal-spawn depth.'),
      })
      .strict(),
    fanOut: z
      .object({
        current: z
          .number()
          .int()
          .nonnegative()
          .describe('Snapshot of activeChildren plus inFlight for this caller.'),
        activeChildren: z.number().int().nonnegative(),
        inFlight: z.number().int().nonnegative(),
        max: z
          .number()
          .int()
          .nonnegative()
          .describe('Configured maximum direct normal-spawn children for one parent.'),
      })
      .strict(),
    rate: z
      .object({
        current: z
          .number()
          .int()
          .nonnegative()
          .describe('App-wide spawn tokens currently used in the sliding window.'),
        max: z.number().int().nonnegative().describe('Configured app-wide window limit.'),
        windowMs: z.number().int().positive().describe('Sliding-window duration; currently 60000.'),
        retryAfterMs: z
          .number()
          .int()
          .nonnegative()
          .describe('Zero on success; wait at least this many milliseconds after a rate denial.'),
      })
      .strict(),
  })
  .strict()
  .describe(
    'Post-success guard-state snapshot. Defaults are depth 3, direct fan-out 10, and 20 app-wide spawns per 60000 ms, but settings can change them. These are recursion/rate guards, not available worker capacity or a parallelism reservation.',
  );

/** Machine-readable success contract published by every MCP transport. */
export const SPAWN_SESSION_OUTPUT_SCHEMA = z
  .object({
    sessionId: z.string().min(1).describe('Canonical Agent Deck target session id.'),
    adapter: z.enum(['claude-code', 'codex-cli', 'grok-build']),
    gateway: z
      .string()
      .min(1)
      .nullable()
      .describe(
        'Recorded Claude Gateway profile; null for Codex/Grok or when Claude uses its native default.',
      ),
    provider: z
      .string()
      .min(1)
      .nullable()
      .describe(
        'Recorded Codex Gateway id in the provider field; null means the target is not Codex or Codex uses its native default config.',
      ),
    cwd: z.string().min(1).max(4096).describe('Requested absolute target working directory.'),
    teamId: z
      .string()
      .min(1)
      .nullable()
      .describe('Durable team id when teamName was set; otherwise null.'),
    teamName: z
      .string()
      .min(1)
      .max(128)
      .nullable()
      .describe('Exact requested team name when teamId is non-null; otherwise null.'),
    agentName: z
      .string()
      .min(1)
      .max(SPAWN_SESSION_AGENT_NAME_MAX_LENGTH)
      .nullable()
      .describe('Requested adapter-native agent selector, or null when omitted.'),
    displayName: z
      .string()
      .min(1)
      .max(SPAWN_SESSION_RESULT_DISPLAY_NAME_MAX_LENGTH)
      .nullable()
      .describe(
        `Requested displayName (at most ${SPAWN_SESSION_EXPLICIT_DISPLAY_NAME_MAX_LENGTH} characters), otherwise the requested agentName (at most ${SPAWN_SESSION_AGENT_NAME_MAX_LENGTH} characters), otherwise null.`,
      ),
    spawnDepth: z
      .number()
      .int()
      .nonnegative()
      .describe(
        'Reported target depth, read from the created session row when available and otherwise computed from caller state. It is not an attestation that a durable spawn link exists.',
      ),
    spawnLimits: SPAWN_SESSION_LIMITS_SCHEMA,
    sentAt: z
      .number()
      .int()
      .nonnegative()
      .describe('Unix epoch milliseconds when Agent Deck built the success response.'),
    spawnPromptMessageId: z
      .string()
      .min(1)
      .nullable()
      .describe(
        'Delivered reply-chain anchor id when one was durably created; null is valid. Only a non-null value can anchor the target first reply.',
      ),
    contextMode: z
      .literal('fork')
      .optional()
      .describe('Present only for a successful requested native fork.'),
    forkedFromSessionId: z
      .string()
      .min(1)
      .optional()
      .describe(
        'Authenticated Agent Deck caller id; present together with contextMode on fork success. It is never a provider-native id.',
      ),
  })
  .strict()
  .superRefine((result, ctx) => {
    if ((result.teamId === null) !== (result.teamName === null)) {
      ctx.addIssue({
        code: 'custom',
        path: ['teamId'],
        message: 'teamId and teamName must both be null or both be non-null',
      });
    }
    if (
      (result.contextMode === 'fork') !==
      (result.forkedFromSessionId !== undefined)
    ) {
      ctx.addIssue({
        code: 'custom',
        path: ['contextMode'],
        message: 'contextMode and forkedFromSessionId must be present together',
      });
    }
    if (result.adapter !== 'claude-code' && result.gateway !== null) {
      ctx.addIssue({
        code: 'custom',
        path: ['gateway'],
        message: 'gateway is only populated for Claude Code',
      });
    }
    if (result.adapter !== 'codex-cli' && result.provider !== null) {
      ctx.addIssue({
        code: 'custom',
        path: ['provider'],
        message: 'provider is only populated for Codex CLI',
      });
    }
  });

export type SpawnSessionLimits = z.infer<typeof SPAWN_SESSION_LIMITS_SCHEMA>;
export type SpawnSessionResult = z.infer<typeof SPAWN_SESSION_OUTPUT_SCHEMA>;
