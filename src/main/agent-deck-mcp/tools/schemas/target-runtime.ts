import { z } from 'zod';
import {
  targetRuntimeFieldsForAdapter,
  type AdapterTargetRuntimeField,
} from '@main/adapters/runtime-control-contracts';
import { getAdapterRuntimeProfile } from '@main/adapters/runtime-profiles';
import { SESSION_THINKING_LEVELS } from '@shared/session-metadata';
import {
  CODEX_APPROVAL_POLICIES,
  PERMISSION_MODES,
  type SessionAdapterId,
} from '@shared/types';
import { MAX_GROK_SANDBOX_PROFILE_LENGTH } from '@shared/grok-sandbox';

const gateway = z
  .string()
  .trim()
  .min(1)
  .max(128)
  .optional()
  .describe(
    'Optional non-null Claude Code Gateway profile id from ~/.claude/gateways, trimmed to 1-128 characters. Only Claude Code accepts this field. Spawn precedence is explicit value, selected bundled-Agent runtime override, persisted same-adapter source, then Claude defaults. Omission never cross-inherits; null and empty-after-trim values reject.',
  );

const provider = z
  .string()
  .trim()
  .min(1)
  .max(128)
  .regex(
    /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/,
    'Codex Gateway id must be a safe TOML filename stem',
  )
  .optional()
  .describe(
    'Optional non-null Codex CLI Gateway id in the public field named provider. It is the safe filename stem of $CODEX_HOME/gateways/<id>.toml, trimmed to 1-128 characters; the selected file is a complete native Codex config, and its optional top-level model_provider is the independent native app-server selector. Only Codex CLI accepts this field. Spawn precedence is explicit value, selected bundled-Agent runtime override, persisted same-adapter source, then no Gateway/native config.toml. Omission never cross-inherits; null, empty-after-trim, unsafe ids, missing files, and malformed TOML reject.',
  );

const model = z
  .string()
  .trim()
  .min(1)
  .max(256)
  .optional()
  .describe(
    'Optional non-null free-text model override, trimmed to 1-256 characters; for spawn_session it applies to the spawned session only. Suggested values include Claude Code haiku, sonnet, opus, and fable; Codex CLI gpt-6-astra, gpt-5.6-sol, gpt-5.6-terra, and gpt-5.6-luna; and Grok Build grok-4.6 and grok-4.5. Suggestions are not an allowlist; the selected runtime validates the value. Spawn precedence is explicit model > resolved agent model > same-adapter source session > selected Gateway/native default. Omission never cross-inherits; null and empty-after-trim values reject.',
  );

const thinking = z
  .enum(SESSION_THINKING_LEVELS)
  .optional()
  .describe(
    'Optional non-null target reasoning level. Claude accepts low, medium, high, xhigh, and max; Codex CLI also accepts ultra; Grok Build accepts low, medium, high, and xhigh. Spawn precedence is explicit thinking > resolved agent effort > same-adapter source session > selected Gateway/native default. Omission never cross-inherits. Adapter-invalid values and null reject before creation.',
  );

const permissionMode = z
  .enum(PERMISSION_MODES)
  .optional()
  .describe(
    'Optional non-null Claude Code-only permission mode: default, acceptEdits, plan, auto, or bypassPermissions. Explicit value wins; omission inherits a selectable persisted same-adapter mode (persisted dontAsk becomes default), while fresh or cross-adapter Claude targets currently use bypassPermissions. Codex CLI approvals and Grok Build ACP permissions use their separate native protocols. Other adapters and null reject.',
  );

const approvalPolicy = z
  .enum(CODEX_APPROVAL_POLICIES)
  .optional()
  .describe(
    'Optional non-null Codex CLI app-server approval policy: untrusted, on-request, or never. Explicit public value wins, followed by any trusted main-only override, persisted same-adapter source, then never. This field does not set Codex network access or arbitrary additional readable directories; those can only come from trusted internal state, same-adapter inheritance, or selected Codex Agent configuration. Other adapters and null reject.',
  );

const sessionMode = z
  .enum(['default', 'plan', 'ask'])
  .optional()
  .describe(
    'Optional non-null Grok Build-only ACP work mode: default, plan, or ask. Explicit value wins; omission inherits a persisted same-adapter mode, otherwise sends no override and accepts the mode Grok Build reports. This is distinct from Claude Code permissionMode and from Grok ACP tool permissions. Other adapters and null reject.',
  );

const codexSandbox = z
  .enum(['workspace-write', 'read-only', 'danger-full-access'])
  .optional()
  .describe(
    'Optional non-null Codex CLI app-server sandbox: workspace-write, read-only, or danger-full-access. Precedence is explicit value, selected Codex Agent runtime, persisted same-adapter source, then configured Codex adapter default. Cross-adapter targets never copy the source sandbox. This is separate from approvalPolicy. Other adapters and null reject.',
  );

const claudeCodeSandbox = z
  .enum(['off', 'workspace-write', 'strict'])
  .optional()
  .describe(
    'Optional non-null Claude Code-only OS sandbox: off, workspace-write, or strict. Explicit value wins; omission uses persisted same-adapter inheritance, otherwise the configured Claude Code adapter default. This is separate from permissionMode. Other adapters and null reject.',
  );

const grokSandbox = z
  .string()
  .trim()
  .min(1)
  .max(MAX_GROK_SANDBOX_PROFILE_LENGTH)
  .refine(
    (profile) => !/[\u0000-\u001f\u007f]/.test(profile),
    'Grok sandbox profile must not contain control characters',
  )
  .optional()
  .describe(
    'Optional non-null Grok Build-only native sandbox profile requested when its ACP child starts. Input is trimmed to 1-128 characters with no control characters. Built-ins are off, workspace, devbox, read-only, and strict; trimmed custom names from user/project sandbox.toml are accepted. Explicit value wins; omission inherits the persisted same-adapter source, otherwise uses the configured Agent Deck Grok default, which may delegate to Grok-native configuration. Managed requirements may override the request, so neither input nor output attests the effective policy. Grok ACP tool permissions remain separate. Other adapters, null, and empty-after-trim values reject.',
  );

const extraAllowWrite = z
  .array(
    z
      .string()
      .min(1)
      .max(4096)
      .refine(
        (path) => path.startsWith('/') || /^[A-Za-z]:[\\/]/.test(path),
        'Writable roots must be absolute paths',
      ),
  )
  .max(16)
  .optional()
  .describe(
    'Optional non-null array of 0-16 additional writable roots outside cwd. Each untrimmed string must use absolute POSIX or drive-letter syntax and contain 1-4096 characters; existence is checked later by the target runtime. Claude Code passes non-empty roots to sandbox.allowWrite; Codex CLI merges them into workspace-write writableRoots. An explicit empty array clears inherited roots. Omission inherits persisted roots only for a same-adapter target; cross-adapter targets use no extra roots. This field cannot set arbitrary readable roots or network access. Grok Build and null reject.',
  );

/**
 * Flat projection used by the current MCP tool factories. Claude and Codex intentionally expose
 * different selector names (`gateway` and `provider`). The adapter-specific schemas below are
 * the ownership SSOT.
 */
export const MCP_TARGET_RUNTIME_SUPERSET_SHAPE = {
  gateway,
  provider,
  model,
  thinking,
  permissionMode,
  approvalPolicy,
  sessionMode,
  codexSandbox,
  claudeCodeSandbox,
  grokSandbox,
  extraAllowWrite,
};

function enumFor(values: readonly string[], description: string) {
  if (values.length === 0) {
    throw new Error('adapter runtime enum must not be empty');
  }
  return z
    .enum(values as [string, ...string[]])
    .optional()
    .describe(description);
}

function schemaForAdapter(adapterId: SessionAdapterId) {
  const profile = getAdapterRuntimeProfile(adapterId);
  const shape: Record<string, z.ZodType> = {};
  for (const field of targetRuntimeFieldsForAdapter(adapterId)) {
    if (field === 'thinking') {
      shape.thinking = enumFor(
        profile.model.thinkingLevels,
        `Reasoning level accepted by ${adapterId}.`,
      );
    } else if (field === 'permissionMode') {
      shape.permissionMode = enumFor(
        profile.runtimeControls.permissionModes,
        `Permission mode accepted by ${adapterId}.`,
      );
    } else if (field === 'sessionMode') {
      shape.sessionMode = enumFor(
        profile.runtimeControls.sessionModes,
        `Session mode accepted by ${adapterId}.`,
      );
    } else {
      shape[field] = MCP_TARGET_RUNTIME_SUPERSET_SHAPE[field];
    }
  }
  return z.object(shape).strict();
}

/**
 * Adapter-layered schemas used for validation, documentation tests, and future schema transports.
 * They deliberately contain only fields the target adapter can honor.
 */
export const MCP_TARGET_RUNTIME_SCHEMAS = {
  'claude-code': schemaForAdapter('claude-code'),
  'codex-cli': schemaForAdapter('codex-cli'),
  'grok-build': schemaForAdapter('grok-build'),
} satisfies Record<SessionAdapterId, z.ZodObject<z.ZodRawShape>>;

export function targetRuntimeSchemaFields(
  adapterId: SessionAdapterId,
): readonly AdapterTargetRuntimeField[] {
  return Object.keys(
    MCP_TARGET_RUNTIME_SCHEMAS[adapterId].shape,
  ) as AdapterTargetRuntimeField[];
}
