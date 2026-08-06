export { ClaudeCodeAdapter } from './adapter-core';
export type {
  ClaudeCodeAdapterHost,
  ClaudeHookIntegration,
} from './adapter-core';

import { ClaudeCodeAdapter } from './adapter-core';
import { desktopClaudeCodeAdapterHost } from './adapter-init-host';

export const claudeCodeAdapter: ClaudeCodeAdapter = new ClaudeCodeAdapter(
  desktopClaudeCodeAdapterHost,
);
