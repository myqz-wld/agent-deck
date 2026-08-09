import {
  resolveClaudeSandboxModeCore,
  type ClaudeSessionDefaultsOptions,
} from './session-defaults-core';
import { desktopClaudeSessionDefaultsHost } from './session-defaults-host';

export type ClaudeSandboxMode = NonNullable<
  ClaudeSessionDefaultsOptions['claudeCodeSandbox']
>;

export function resolveClaudeSandboxMode(opts: {
  resume?: string;
  claudeCodeSandbox?: ClaudeSandboxMode;
}): ClaudeSandboxMode {
  return resolveClaudeSandboxModeCore(opts, desktopClaudeSessionDefaultsHost);
}
