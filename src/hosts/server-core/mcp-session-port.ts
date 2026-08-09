import type {
  GetSessionResult,
  ListSessionEventsArgs,
  ListSessionEventsResult,
  ListSessionsArgs,
  ListSessionsResult,
  SendMessageArgs,
  SendMessageResult,
  ShutdownSessionArgs,
  ShutdownSessionResult,
} from '@main/agent-deck-mcp/tools/schemas';

/** Authenticated session collaboration owned by the headless Core, never Electron main. */
export interface ServerCoreMcpSessionPort {
  start(): Promise<void>;
  stop(): Promise<void>;
  drainForHandOff(sessionId: string, timeoutMs?: number): Promise<boolean>;
  list(callerSessionId: string, args: ListSessionsArgs): ListSessionsResult;
  get(callerSessionId: string, sessionId: string): GetSessionResult;
  listEvents(
    callerSessionId: string,
    args: ListSessionEventsArgs,
  ): ListSessionEventsResult;
  send(
    callerSessionId: string,
    args: SendMessageArgs,
  ): SendMessageResult;
  shutdown(
    callerSessionId: string,
    args: ShutdownSessionArgs,
  ): Promise<ShutdownSessionResult>;
}
