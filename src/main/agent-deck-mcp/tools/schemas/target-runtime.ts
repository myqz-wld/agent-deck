import { z } from 'zod';
import {
  targetRuntimeFieldsForAdapter,
  type AdapterTargetRuntimeField,
} from '@main/adapters/runtime-control-contracts';
import { getAdapterRuntimeProfile } from '@main/adapters/runtime-profiles';
import { SESSION_THINKING_LEVELS } from '@shared/session-metadata';
import { PERMISSION_MODES, type SessionAdapterId } from '@shared/types';

const provider = z
  .string()
  .trim()
  .min(1)
  .max(128)
  .optional()
  .describe(
    'Optional provider override for the target session. claude-code accepts a Gateway profile id from ~/.claude/gateways; codex-cli accepts a model_provider id from ~/.codex/config.toml; grok-build rejects this field. Explicit values outrank resolved Agent runtime and same-adapter inheritance; omission preserves the applicable same-adapter or target-native default.',
  );

const model = z
  .string()
  .trim()
  .min(1)
  .max(256)
  .optional()
  .describe(
    'Optional free-text model override for the target session; for spawn_session it applies to the spawned session only. Suggested values include Claude haiku, sonnet, opus, and fable; Codex gpt-5.6-sol, gpt-5.6-terra, gpt-5.6-luna, gpt-5.5, and gpt-5.4; and Grok Build grok-4.5. Suggestions are not an allowlist: the selected provider remains authoritative. Spawn precedence is explicit model > resolved agent model > same-adapter source session > provider default. A hand-off follows the equivalent explicit, same-adapter, then target-provider precedence.',
  );

const thinking = z
  .enum(SESSION_THINKING_LEVELS)
  .optional()
  .describe(
    'Optional target reasoning level. Claude accepts low, medium, high, xhigh, and max; Codex accepts low, medium, high, xhigh, max, and ultra; Grok Build accepts low, medium, high, and xhigh. Spawn precedence is explicit thinking > resolved agent effort > same-adapter source session > provider default. A hand-off follows the equivalent explicit, same-adapter, then target-provider precedence. Adapter-invalid values are rejected before session creation.',
  );

const permissionMode = z
  .enum(PERMISSION_MODES)
  .optional()
  .describe(
    'Optional Claude Code permission mode. This field is owned only by adapter="claude-code"; omitted same-adapter targets may inherit it, while fresh Claude targets use the Claude target default. Codex approval requests and Grok ACP permissions use their provider-native protocols.',
  );

const sessionMode = z
  .enum(['default', 'plan', 'ask'])
  .optional()
  .describe(
    'Optional Grok Build work mode. This field is owned only by adapter="grok-build", may inherit across same-adapter targets when omitted, and is distinct from Claude permissionMode.',
  );

const codexSandbox = z
  .enum(['workspace-write', 'read-only', 'danger-full-access'])
  .optional()
  .describe(
    'Optional Codex app-server sandbox override. This field is owned only by adapter="codex-cli"; omission uses resolved Agent runtime, same-adapter inheritance, or the Codex adapter default as applicable.',
  );

const claudeCodeSandbox = z
  .enum(['off', 'workspace-write', 'strict'])
  .optional()
  .describe(
    'Optional Claude Code OS sandbox override. This field is owned only by adapter="claude-code"; omission uses same-adapter inheritance or the Claude adapter default as applicable.',
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
    'Optional absolute writable roots outside cwd. claude-code passes them to sandbox.allowWrite and codex-cli merges them into workspace-write writableRoots; same-adapter targets may inherit them when omitted. grok-build keeps ACP-native tool permissions and rejects this field.',
  );

/**
 * Flat compatibility projection used by the current MCP tool factories. The public call shape
 * stays stable, while the adapter-specific schemas below are the ownership SSOT and every
 * user-facing handler rejects fields outside the selected target contract.
 */
export const MCP_TARGET_RUNTIME_SUPERSET_SHAPE = {
  provider,
  model,
  thinking,
  permissionMode,
  sessionMode,
  codexSandbox,
  claudeCodeSandbox,
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
 * They deliberately contain only fields the target provider can honor.
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
