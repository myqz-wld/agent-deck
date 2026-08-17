import { z } from 'zod';

import {
  SESSION_CONSOLE_MAX_INITIAL_MESSAGE_BYTES,
  parseWorkspaceDirectoryRef,
} from '@contracts/index';
import { MAX_GROK_SANDBOX_PROFILE_LENGTH } from '@shared/grok-sandbox';
import { SESSION_THINKING_LEVELS } from '@shared/session-metadata';
import { CODEX_APPROVAL_POLICIES, PERMISSION_MODES } from '@shared/types';

const text = (maximum: number) => z.string().min(1).max(maximum).refine(
  (value) => !/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/u.test(value),
  'Control characters are not allowed',
);

const optionalRuntimeText = text(256).optional();
const optionalGatewayId = z.string().trim().min(1).max(128).regex(
  /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/,
  'Use a safe Gateway filename stem',
).optional();
const agentName = z.string().min(1).max(257).regex(
  /^[a-zA-Z0-9._-]{1,128}(?::[a-zA-Z0-9._-]{1,128})?$/,
  'Use an Agent name containing letters, digits, dot, underscore, or hyphen',
);

export const SERVER_CORE_SPAWN_SESSION_SCHEMA = {
  adapter: z.enum(['claude-code', 'codex-cli', 'grok-build']).describe(
    'Target provider adapter. Availability and defaults are revalidated by the current Core.',
  ),
  cwd: z.string().min(1).max(1_024).refine((value) => {
    try {
      parseWorkspaceDirectoryRef(value, 'spawn_session.cwd');
      return true;
    } catch {
      return false;
    }
  }, 'Use "." or a normalized Workspace-relative directory').describe(
    'Workspace-relative target directory. Absolute host and Worker paths are never accepted.',
  ),
  prompt: z.string().min(1).max(SESSION_CONSOLE_MAX_INITIAL_MESSAGE_BYTES).describe(
    'Self-contained first user message for the spawned session.',
  ),
  contextMode: z.enum(['fresh', 'fork']).optional().describe(
    'Omission means fresh. Fork natively inherits only the authenticated active caller history and requires the exact adapter, adapter-native runtime selector, and realpath cwd; it never falls back silently.',
  ),
  teamName: text(128).optional().describe(
    'Optional active Agent Deck team. The authenticated caller becomes or remains its lead.',
  ),
  displayName: text(80).optional().describe('Optional human-readable teammate title.'),
  agentName: agentName.optional().describe(
    'Optional built-in Agent Deck Agent selector. Its model and reasoning settings come from this node; explicit runtime fields win.',
  ),
  gateway: optionalGatewayId.describe('Claude Gateway profile id; Claude targets only.'),
  provider: optionalGatewayId.describe(
    'Codex Gateway id from $CODEX_HOME/gateways/<id>.toml; Codex targets only.',
  ),
  model: optionalRuntimeText.describe('Optional provider model override.'),
  thinking: z.enum(SESSION_THINKING_LEVELS).optional(),
  permissionMode: z.enum(PERMISSION_MODES).optional(),
  approvalPolicy: z.enum(CODEX_APPROVAL_POLICIES).optional(),
  sessionMode: z.enum(['default', 'plan', 'ask']).optional(),
  codexSandbox: z.enum(['workspace-write', 'read-only', 'danger-full-access']).optional(),
  claudeCodeSandbox: z.enum(['off', 'workspace-write', 'strict']).optional(),
  grokSandbox: text(MAX_GROK_SANDBOX_PROFILE_LENGTH).optional(),
};
