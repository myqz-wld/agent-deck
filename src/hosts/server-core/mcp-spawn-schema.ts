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
  gateway: optionalRuntimeText.describe('Claude Gateway profile id; Claude targets only.'),
  provider: optionalRuntimeText.describe('Codex model_provider id; Codex targets only.'),
  model: optionalRuntimeText.describe('Optional provider model override.'),
  thinking: z.enum(SESSION_THINKING_LEVELS).optional(),
  permissionMode: z.enum(PERMISSION_MODES).optional(),
  approvalPolicy: z.enum(CODEX_APPROVAL_POLICIES).optional(),
  sessionMode: z.enum(['default', 'plan', 'ask']).optional(),
  codexSandbox: z.enum(['workspace-write', 'read-only', 'danger-full-access']).optional(),
  claudeCodeSandbox: z.enum(['off', 'workspace-write', 'strict']).optional(),
  grokSandbox: text(MAX_GROK_SANDBOX_PROFILE_LENGTH).optional(),
};
