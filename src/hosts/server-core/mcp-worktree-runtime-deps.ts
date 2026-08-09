import type { AgentAdapter } from '@main/adapters/types';
import type { SessionRecord } from '@shared/types';

import type { ServerCoreWorktreeCleanup } from './mcp-worktree-cleanup';

export interface ServerCoreWorktreeRuntimeDependencies {
  readonly sessions: {
    get(sessionId: string): SessionRecord | null;
    setCwd(sessionId: string, cwd: string): void;
  };
  readonly registry: {
    get(adapterId: string): AgentAdapter | undefined;
    list(): AgentAdapter[];
  };
  readonly cleanup: ServerCoreWorktreeCleanup;
  readonly publishSession: (sessionId: string) => void;
  readonly publishStatus: (
    sessionId: string,
    text: string,
    error: boolean,
    generation: number,
  ) => void;
  readonly warn: (message: string) => void;
}
