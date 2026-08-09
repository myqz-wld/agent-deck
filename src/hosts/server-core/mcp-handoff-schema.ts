import { z } from 'zod';

import {
  SESSION_CONSOLE_MAX_INITIAL_MESSAGE_BYTES,
  parseWorkspaceDirectoryRef,
} from '@contracts/index';
import { SERVER_CORE_SPAWN_SESSION_SCHEMA } from './mcp-spawn-schema';

const optionalAdapter = z.enum(['claude-code', 'codex-cli', 'grok-build']).optional().describe(
  'Optional successor adapter. Omission inherits the authenticated caller adapter.',
);

const optionalCwd = z.string().min(1).max(1_024).refine((value) => {
  try {
    parseWorkspaceDirectoryRef(value, 'hand_off_session.cwd');
    return true;
  } catch {
    return false;
  }
}, 'Use "." or a normalized Workspace-relative directory').optional().describe(
  'Optional Workspace-relative successor directory. Omission keeps the caller directory.',
);

export const SERVER_CORE_HANDOFF_SESSION_SCHEMA = {
  prompt: z.string().min(1).max(SESSION_CONSOLE_MAX_INITIAL_MESSAGE_BYTES).refine(
    (value) => Buffer.byteLength(value, 'utf8') <= SESSION_CONSOLE_MAX_INITIAL_MESSAGE_BYTES,
    'Continuation instruction is too large',
  ).describe(
    'Authoritative instruction for a fresh successor. Core privately supplies bounded continuation evidence.',
  ),
  cwd: optionalCwd,
  adapter: optionalAdapter,
  gateway: SERVER_CORE_SPAWN_SESSION_SCHEMA.gateway,
  provider: SERVER_CORE_SPAWN_SESSION_SCHEMA.provider,
  model: SERVER_CORE_SPAWN_SESSION_SCHEMA.model,
  thinking: SERVER_CORE_SPAWN_SESSION_SCHEMA.thinking,
  permissionMode: SERVER_CORE_SPAWN_SESSION_SCHEMA.permissionMode,
  approvalPolicy: SERVER_CORE_SPAWN_SESSION_SCHEMA.approvalPolicy,
  sessionMode: SERVER_CORE_SPAWN_SESSION_SCHEMA.sessionMode,
  codexSandbox: SERVER_CORE_SPAWN_SESSION_SCHEMA.codexSandbox,
  claudeCodeSandbox: SERVER_CORE_SPAWN_SESSION_SCHEMA.claudeCodeSandbox,
  grokSandbox: SERVER_CORE_SPAWN_SESSION_SCHEMA.grokSandbox,
};
