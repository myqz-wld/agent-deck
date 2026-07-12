import { AGENT_DECK_MCP_SERVER_NAME } from '@main/codex-config/agent-deck-mcp-injector';
import type { CodexAppServerNotification } from './protocol';

type McpStartupState = 'starting' | 'ready' | 'failed' | 'cancelled';

export interface McpStartupLogEvent {
  level: 'info' | 'warn';
  message: string;
}

/**
 * Turns the app-server MCP lifecycle notification into one bounded, actionable log entry.
 * The observer deliberately ignores user-configured MCP servers so normal startup does not
 * amplify logs in proportion to the user's server count.
 */
export class AgentDeckMcpStartupObserver {
  private readonly startedAtByThread = new Map<string, number>();
  private readonly lastStateByThread = new Map<string, McpStartupState>();

  constructor(private readonly now: () => number = Date.now) {}

  observe(notification: CodexAppServerNotification): McpStartupLogEvent | null {
    if (notification.method !== 'mcpServer/startupStatus/updated') return null;
    const params = asRecord(notification.params);
    if (!params || params.name !== AGENT_DECK_MCP_SERVER_NAME) return null;

    const status = readStartupState(params.status);
    if (!status) return null;
    const threadId = typeof params.threadId === 'string' ? params.threadId : 'unscoped';
    if (this.lastStateByThread.get(threadId) === status) return null;
    this.lastStateByThread.set(threadId, status);

    if (status === 'starting') {
      this.startedAtByThread.set(threadId, this.now());
      return {
        level: 'info',
        message: `[codex-app-server] agent-deck MCP startup starting (thread=${threadId})`,
      };
    }

    const startedAt = this.startedAtByThread.get(threadId);
    this.startedAtByThread.delete(threadId);
    const elapsed = startedAt === undefined ? null : Math.max(0, this.now() - startedAt);
    // Required MCP notifications may be buffered until thread/resume settles, making both arrive
    // in the same millisecond after a real multi-second handshake. The client logs RPC wall time;
    // omit a misleading zero-duration notification delta here.
    const duration = elapsed === null || elapsed === 0 ? '' : `, durationMs=${elapsed}`;
    if (status === 'ready') {
      return {
        level: 'info',
        message: `[codex-app-server] agent-deck MCP startup ready (thread=${threadId}${duration})`,
      };
    }

    const reason = sanitizeMcpDiagnostic(params.failureReason);
    const error = sanitizeMcpDiagnostic(params.error);
    return {
      level: 'warn',
      message:
        `[codex-app-server] agent-deck MCP startup ${status} ` +
        `(thread=${threadId}${duration}` +
        `${reason ? `, reason=${reason}` : ''}${error ? `, error=${error}` : ''})`,
    };
  }

  reset(): void {
    this.startedAtByThread.clear();
    this.lastStateByThread.clear();
  }
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function readStartupState(value: unknown): McpStartupState | null {
  return value === 'starting' || value === 'ready' || value === 'failed' || value === 'cancelled'
    ? value
    : null;
}

export function sanitizeMcpDiagnostic(value: unknown): string | null {
  const raw = value instanceof Error ? value.message : value;
  if (typeof raw !== 'string') return null;
  const normalized = raw
    .replace(/Bearer\s+[^\s,;)]+/gi, 'Bearer [redacted]')
    .replace(/([?&](?:token|key|secret)=)[^&\s]+/gi, '$1[redacted]')
    .replace(/\s+/g, ' ')
    .trim();
  return normalized ? normalized.slice(0, 2_000) : null;
}
