import type { SessionAdapterId } from '@shared/types';

export interface ServerCoreSpawnSessionArgs {
  readonly adapter: SessionAdapterId;
  readonly cwd: string;
  readonly prompt: string;
  readonly contextMode?: 'fresh' | 'fork';
  readonly teamName?: string;
  readonly displayName?: string;
  readonly agentName?: string;
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

export interface ServerCoreSpawnLimits {
  readonly depth: { readonly current: number; readonly next: number; readonly max: number };
  readonly fanOut: {
    readonly current: number;
    readonly activeChildren: number;
    readonly inFlight: number;
    readonly max: number;
  };
  readonly rate: {
    readonly current: number;
    readonly max: number;
    readonly windowMs: number;
    readonly retryAfterMs: number;
  };
}

interface ServerCoreSpawnSessionResultBase {
  readonly sessionId: string;
  readonly adapter: SessionAdapterId;
  readonly gateway: string | null;
  readonly provider: string | null;
  readonly cwd: string;
  readonly teamId: string | null;
  readonly teamName: string | null;
  readonly displayName: string | null;
  readonly agentName: string | null;
  readonly spawnDepth: number;
  readonly spawnLimits: ServerCoreSpawnLimits;
  readonly sentAt: number;
  readonly spawnPromptMessageId: string;
}

export type ServerCoreSpawnSessionResult = ServerCoreSpawnSessionResultBase & (
  | { readonly contextMode?: never; readonly forkedFromSessionId?: never }
  | { readonly contextMode: 'fork'; readonly forkedFromSessionId: string }
);

export interface ServerCoreMcpSpawnPort {
  spawn(
    callerSessionId: string,
    args: ServerCoreSpawnSessionArgs,
  ): Promise<ServerCoreSpawnSessionResult>;
}
