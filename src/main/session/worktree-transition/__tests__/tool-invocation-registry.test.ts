import { describe, expect, it } from 'vitest';
import type { AgentEvent } from '@shared/types';
import {
  directionForWorktreeToolName,
  WorktreeToolInvocationRegistry,
} from '../tool-invocation-registry';

function toolStart(
  sessionId: string,
  toolUseId: string,
  toolName: string,
  ts = 1_000,
): AgentEvent {
  return {
    sessionId,
    agentId: 'codex-cli',
    kind: 'tool-use-start',
    payload: { toolUseId, toolName },
    ts,
    source: 'sdk',
  };
}

function toolEnd(
  sessionId: string,
  toolUseId: string,
  ts = 1_001,
): AgentEvent {
  return {
    sessionId,
    agentId: 'codex-cli',
    kind: 'tool-use-end',
    payload: { toolUseId, status: 'failed' },
    ts,
    source: 'sdk',
  };
}

describe('WorktreeToolInvocationRegistry', () => {
  it('recognizes only the exact public MCP tool names', () => {
    expect(
      directionForWorktreeToolName('mcp__agent-deck__enter_worktree'),
    ).toBe('enter');
    expect(
      directionForWorktreeToolName('mcp__agent-deck__exit_worktree'),
    ).toBe('exit');
    expect(directionForWorktreeToolName('enter_worktree')).toBeNull();
    expect(
      directionForWorktreeToolName('mcp__other__enter_worktree'),
    ).toBeNull();
  });

  it('claims one exact session/direction/tool id and binds its generation', () => {
    const registry = new WorktreeToolInvocationRegistry();
    registry.observe(
      toolStart(
        'session-a',
        'tool-a',
        'mcp__agent-deck__enter_worktree',
      ),
    );
    registry.observe(
      toolStart(
        'session-b',
        'tool-b',
        'mcp__agent-deck__enter_worktree',
      ),
    );
    expect(registry.reserve('session-a', 'enter', 1_001)).toBe('tool-a');
    registry.bindGeneration('session-a', 'tool-a', 7);
    expect(() => registry.reserve('session-a', 'enter', 1_002)).toThrow(
      'no provider-observed tool invocation',
    );
    registry.release('session-a', 'tool-a', 6);
    expect(() => registry.reserve('session-a', 'enter', 1_003)).toThrow();
    registry.release('session-a', 'tool-a', 7);
  });

  it('rejects ambiguous, stale, hook, and cross-direction observations', () => {
    const registry = new WorktreeToolInvocationRegistry();
    registry.observe(
      toolStart(
        'session-a',
        'tool-a',
        'mcp__agent-deck__enter_worktree',
      ),
    );
    registry.observe(
      toolStart(
        'session-a',
        'tool-b',
        'mcp__agent-deck__enter_worktree',
        1_001,
      ),
    );
    expect(() => registry.reserve('session-a', 'enter', 1_002)).toThrow(
      'ambiguous',
    );
    expect(() => registry.reserve('session-a', 'exit', 1_002)).toThrow(
      'no provider-observed',
    );

    const hookEvent = toolStart(
      'session-c',
      'tool-c',
      'mcp__agent-deck__exit_worktree',
    );
    hookEvent.source = 'hook';
    registry.observe(hookEvent);
    expect(() => registry.reserve('session-c', 'exit', 1_001)).toThrow();

    const stale = new WorktreeToolInvocationRegistry();
    stale.observe(
      toolStart(
        'session-d',
        'tool-d',
        'mcp__agent-deck__exit_worktree',
        1_000,
      ),
    );
    expect(() =>
      stale.reserve('session-d', 'exit', 1_000 + 5 * 60_000 + 1),
    ).toThrow('no provider-observed');
  });

  it('moves an outstanding invocation when the application session id heals', () => {
    const registry = new WorktreeToolInvocationRegistry();
    registry.observe(
      toolStart(
        'temporary',
        'tool-a',
        'mcp__agent-deck__enter_worktree',
      ),
    );
    registry.renameSession('temporary', 'native');
    expect(() => registry.reserve('temporary', 'enter', 1_001)).toThrow();
    expect(registry.reserve('native', 'enter', 1_001)).toBe('tool-a');
  });

  it('releases an unclaimed invocation when an early-return tool result ends', () => {
    const registry = new WorktreeToolInvocationRegistry();
    registry.observe(
      toolStart(
        'session-a',
        'tool-failed',
        'mcp__agent-deck__exit_worktree',
      ),
    );
    registry.observe(toolEnd('session-a', 'tool-failed'));
    registry.observe(
      toolStart(
        'session-a',
        'tool-retry',
        'mcp__agent-deck__exit_worktree',
        1_002,
      ),
    );
    expect(registry.reserve('session-a', 'exit', 1_003)).toBe(
      'tool-retry',
    );
  });
});
