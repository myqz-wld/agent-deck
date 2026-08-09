import {
  createClaudeFamilyForkedSessionCore,
  type CreateClaudeFamilyForkArgs,
} from './fork-session-core';
import { desktopClaudeFamilyForkHost } from './fork-session-host';

export {
  encodeClaudeSdkProjectKey,
  getClaudeConfigRoot,
  parseCompleteClaudeJsonl,
  selectClaudeForkBoundary,
  type ClaudeTranscriptEntry,
  type CreateClaudeFamilyForkArgs,
} from './fork-session-core';

export function createClaudeFamilyForkedSession(args: CreateClaudeFamilyForkArgs) {
  return createClaudeFamilyForkedSessionCore(args, desktopClaudeFamilyForkHost);
}
