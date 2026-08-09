import type { CanUseTool } from '@anthropic-ai/claude-agent-sdk';
import {
  makeCanUseToolCore,
  type MakeCanUseToolDeps,
} from './can-use-tool-core';
import { desktopClaudeCanUseToolHost } from './can-use-tool-host';

export type { MakeCanUseToolDeps } from './can-use-tool-core';

export function makeCanUseTool(deps: MakeCanUseToolDeps): CanUseTool {
  return makeCanUseToolCore(deps, desktopClaudeCanUseToolHost);
}
