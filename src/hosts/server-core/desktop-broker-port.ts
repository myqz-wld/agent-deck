import type {
  AuthenticatedClientAccessContext,
  DesktopBrokerBrowserOperation,
  DesktopBrokerNextParams,
  DesktopBrokerRequestDto,
  DesktopBrokerRespondParams,
  DesktopBrokerToolResult,
  JsonObject,
} from '@contracts/index';

export interface ServerCoreDesktopBrokerPort {
  start(): Promise<void>;
  stop(): Promise<void>;
  invoke(
    sessionId: string,
    operation: DesktopBrokerBrowserOperation,
    args: JsonObject,
  ): Promise<DesktopBrokerToolResult>;
  next(
    access: AuthenticatedClientAccessContext,
    params: DesktopBrokerNextParams,
    signal: AbortSignal,
  ): Promise<{ request: DesktopBrokerRequestDto | null }>;
  respond(
    access: AuthenticatedClientAccessContext,
    params: DesktopBrokerRespondParams,
  ): { accepted: true };
  releaseSession(sessionId: string, reason?: string): void;
  renameSession(fromSessionId: string, toSessionId: string): void;
}

export type ServerCoreDesktopBrokerErrorCode =
  | 'cancelled'
  | 'conflict'
  | 'limit'
  | 'not-found'
  | 'stopped'
  | 'timeout'
  | 'unavailable';

export class ServerCoreDesktopBrokerError extends Error {
  constructor(
    readonly code: ServerCoreDesktopBrokerErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'ServerCoreDesktopBrokerError';
  }
}
