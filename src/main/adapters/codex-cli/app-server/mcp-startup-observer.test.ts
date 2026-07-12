import { describe, expect, it } from 'vitest';
import { AgentDeckMcpStartupObserver } from './mcp-startup-observer';

describe('AgentDeckMcpStartupObserver', () => {
  it('records the Agent Deck starting-to-ready duration once', () => {
    let now = 1_000;
    const observer = new AgentDeckMcpStartupObserver(() => now);
    const starting = {
      method: 'mcpServer/startupStatus/updated',
      params: { threadId: 'thread-1', name: 'agent-deck', status: 'starting' },
    };

    expect(observer.observe(starting)).toEqual({
      level: 'info',
      message: '[codex-app-server] agent-deck MCP startup starting (thread=thread-1)',
    });
    expect(observer.observe(starting)).toBeNull();

    now = 1_125;
    expect(observer.observe({
      method: 'mcpServer/startupStatus/updated',
      params: { threadId: 'thread-1', name: 'agent-deck', status: 'ready' },
    })).toEqual({
      level: 'info',
      message: '[codex-app-server] agent-deck MCP startup ready (thread=thread-1, durationMs=125)',
    });
  });

  it('keeps bounded failure diagnostics without logging other MCP servers', () => {
    const observer = new AgentDeckMcpStartupObserver(() => 4_000);
    expect(observer.observe({
      method: 'mcpServer/startupStatus/updated',
      params: { threadId: 'thread-1', name: 'other-server', status: 'failed' },
    })).toBeNull();

    expect(observer.observe({
      method: 'mcpServer/startupStatus/updated',
      params: {
        threadId: null,
        name: 'agent-deck',
        status: 'failed',
        failureReason: 'reauthenticationRequired',
        error: 'Authorization: Bearer super-secret\n token unavailable',
      },
    })).toEqual({
      level: 'warn',
      message:
        '[codex-app-server] agent-deck MCP startup failed ' +
        '(thread=unscoped, reason=reauthenticationRequired, ' +
        'error=Authorization: Bearer [redacted] token unavailable)',
    });
  });

  it('can observe a new process lifecycle after reset', () => {
    const observer = new AgentDeckMcpStartupObserver(() => 1);
    const ready = {
      method: 'mcpServer/startupStatus/updated',
      params: { threadId: 'thread-1', name: 'agent-deck', status: 'ready' },
    };
    expect(observer.observe(ready)).not.toBeNull();
    expect(observer.observe(ready)).toBeNull();
    observer.reset();
    expect(observer.observe(ready)).not.toBeNull();
  });

  it('omits a misleading zero duration when required notifications arrive buffered', () => {
    const observer = new AgentDeckMcpStartupObserver(() => 5_000);
    observer.observe({
      method: 'mcpServer/startupStatus/updated',
      params: { threadId: 'thread-1', name: 'agent-deck', status: 'starting' },
    });
    expect(observer.observe({
      method: 'mcpServer/startupStatus/updated',
      params: { threadId: 'thread-1', name: 'agent-deck', status: 'ready' },
    })?.message).toBe(
      '[codex-app-server] agent-deck MCP startup ready (thread=thread-1)',
    );
  });
});
