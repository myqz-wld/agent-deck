import type { AgentEvent, SessionAdapterId, UploadedAttachmentRef } from '@shared/types';

export interface ServerCoreEnterWorktreeArgs {
  readonly startPoint: string;
  readonly worktreePath?: string;
  readonly worktreeRoot?: string;
}

export interface ServerCoreExitWorktreeArgs {
  readonly worktreePath?: string;
  readonly discardChanges?: boolean;
}

export interface ServerCoreWorktreeWaitingResult {
  readonly transitionId: string;
  readonly direction: 'enter' | 'exit';
  readonly state: 'waiting-tool-result';
  readonly effectiveFrom: 'automatic-next-turn';
  readonly worktreePath: string;
  readonly startCommit?: string;
  readonly headMode?: 'detached';
}

export interface ServerCoreWorktreeCleanupResult {
  readonly transitionId: string;
  readonly direction: 'exit';
  readonly state: 'completed-cleanup';
  readonly effectiveFrom: 'already-effective';
  readonly worktreePath: string;
  readonly worktreeRemoved: boolean;
}

export type ServerCoreExitWorktreeResult =
  | ServerCoreWorktreeWaitingResult
  | ServerCoreWorktreeCleanupResult;

export interface ServerCoreWorktreeIngressInput {
  readonly sourceSessionId: string;
  readonly agentId: SessionAdapterId;
  readonly text: string;
  readonly attachments?: UploadedAttachmentRef[];
  readonly emit: (event: AgentEvent) => void;
  readonly bypassWorktreeTransition?: boolean;
}

export interface ServerCoreMcpWorktreePort {
  enter(
    callerSessionId: string,
    args: ServerCoreEnterWorktreeArgs,
  ): Promise<ServerCoreWorktreeWaitingResult>;
  exit(
    callerSessionId: string,
    args: ServerCoreExitWorktreeArgs,
  ): Promise<ServerCoreExitWorktreeResult>;
}

export interface ServerCoreWorktreeRuntimePort extends ServerCoreMcpWorktreePort {
  start(): Promise<void>;
  stop(): Promise<void>;
  observe(event: AgentEvent): boolean;
  hasPendingTransition(sessionId: string): boolean;
  guardIngress(input: ServerCoreWorktreeIngressInput): boolean;
  renameSession(fromSessionId: string, toSessionId: string): void;
}

export class ServerCoreWorktreeError extends Error {
  constructor(
    message: string,
    readonly hint: string,
  ) {
    super(message);
    this.name = 'ServerCoreWorktreeError';
  }
}

/** Creation crossed the Git mutation boundary without proving rollback completion. */
export class ServerCoreWorktreeCleanupUnprovedError extends ServerCoreWorktreeError {
  constructor() {
    super(
      'Git worktree 创建后的清理尚未确认',
      'Core 已保留 durable lease；请检查仓库 worktree 状态后再重试恢复。',
    );
    this.name = 'ServerCoreWorktreeCleanupUnprovedError';
  }
}
