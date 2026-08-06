import { describe, expect, it, vi } from 'vitest';
import type { AgentEvent } from '@shared/types';
import { createProviderAdapterContext } from './provider-adapter-context-core';

describe('provider adapter context Core', () => {
  it('keeps live ports while snapshotting the immutable path envelope', () => {
    let running = false;
    const hookServer = {
      get isRunning() { return running; },
      listeningPort: 4312,
      bearerToken: 'hook-token',
      mcpBearerToken: 'mcp-token',
    };
    const routeRegistry = { registerForAdapter: vi.fn() };
    const emit = vi.fn<(event: AgentEvent) => void>();
    const paths = {
      appUserData: '/data',
      userHome: '/home/test',
      userClaudeSettings: '/home/test/.claude/settings.json',
    };

    const context = createProviderAdapterContext({
      hookServer,
      routeRegistry,
      emit,
      paths,
    });
    paths.appUserData = '/changed';
    running = true;

    expect(context.hookServer).toBe(hookServer);
    expect(context.routeRegistry).toBe(routeRegistry);
    expect(context.hookServer.isRunning).toBe(true);
    expect(context.paths.appUserData).toBe('/data');
    expect(Object.isFrozen(context)).toBe(true);
    expect(Object.isFrozen(context.paths)).toBe(true);
  });
});
