import { resolveClaudeModelCore } from './session-defaults-core';
import { desktopClaudeSessionDefaultsHost } from './session-defaults-host';

export function resolveClaudeModel(opts: {
  resume?: string;
  model?: string;
  profileDefaultModel?: string;
}): string | undefined {
  return resolveClaudeModelCore(opts, desktopClaudeSessionDefaultsHost);
}
