import type { SessionAdapterId } from '@shared/types';

export interface ClaudeMcpSessionIdentity {
  applicationSid: string;
}

export interface ClaudeMcpServerHost<T> {
  createServer(
    callerSessionIdProvider: () => string,
    adapterId: Extract<SessionAdapterId, 'claude-code'>,
  ): Promise<T | null>;
  onServerAttached(): void;
  readEnabled(): boolean;
}

/** Build one session's MCP attachment without discovering desktop settings or diagnostics. */
export async function buildMcpServersWithHost<T>(
  host: ClaudeMcpServerHost<T>,
  internal: ClaudeMcpSessionIdentity,
  adapterId: Extract<SessionAdapterId, 'claude-code'>,
): Promise<{ agentDeckMcpServer: T | null }> {
  if (!host.readEnabled()) return { agentDeckMcpServer: null };

  const agentDeckMcpServer = await host.createServer(
    () => internal.applicationSid,
    adapterId,
  );
  if (agentDeckMcpServer) host.onServerAttached();
  return { agentDeckMcpServer };
}
