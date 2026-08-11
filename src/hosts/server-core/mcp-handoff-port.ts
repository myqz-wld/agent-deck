import type { HandOffSessionResult } from '@main/agent-deck-mcp/tools/schemas';
import type { SessionAdapterId } from '@shared/types';
import type { SessionHandOffPreviewResult } from '@contracts/index';

export interface ServerCoreHandOffSessionArgs {
  readonly prompt: string;
  readonly cwd?: string;
  readonly capabilityRevision?: string;
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
  preview(
    callerSessionId: string,
    args: ServerCoreHandOffSessionArgs,
  ): Promise<SessionHandOffPreviewResult>;
  handOff(
    callerSessionId: string,
    args: ServerCoreHandOffSessionArgs,
    expectedPreviewDigest?: string,
  ): Promise<HandOffSessionResult>;
}
