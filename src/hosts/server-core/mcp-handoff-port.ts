import type { HandOffSessionResult } from '@main/agent-deck-mcp/tools/schemas';
import type { SessionAdapterId } from '@shared/types';

export interface ServerCoreHandOffSessionArgs {
  readonly prompt: string;
  readonly cwd?: string;
  readonly adapter?: SessionAdapterId;
  readonly gateway?: string;
  readonly provider?: string;
  readonly model?: string;
  readonly thinking?: string;
  readonly permissionMode?: string;
  readonly approvalPolicy?: string;
  readonly sessionMode?: string;
  readonly codexSandbox?: string;
  readonly claudeCodeSandbox?: string;
  readonly grokSandbox?: string;
}

export interface ServerCoreMcpHandOffPort {
  handOff(
    callerSessionId: string,
    args: ServerCoreHandOffSessionArgs,
  ): Promise<HandOffSessionResult>;
}
