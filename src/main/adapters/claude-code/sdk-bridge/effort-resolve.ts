import type { ClaudeCodeEffortLevel } from '@main/adapters/types';
import { resolveClaudeEffortCore } from './session-defaults-core';
import { desktopClaudeSessionDefaultsHost } from './session-defaults-host';

export function resolveClaudeEffort(opts: {
  resume?: string;
  claudeCodeEffortLevel?: ClaudeCodeEffortLevel;
}): ClaudeCodeEffortLevel | undefined {
  return resolveClaudeEffortCore(opts, desktopClaudeSessionDefaultsHost);
}
