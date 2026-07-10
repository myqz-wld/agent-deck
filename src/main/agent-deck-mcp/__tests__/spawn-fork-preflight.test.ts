import { describe, expect, it, vi } from 'vitest';
import type { AgentAdapter, CreateSessionOptions } from '@main/adapters/types';
import type { SessionRecord } from '@shared/types';
import { validateSpawnForkPreflight } from '../tools/handlers/spawn-fork-preflight';

function caller(overrides: Partial<SessionRecord> = {}): SessionRecord {
  return {
    id: 'caller',
    agentId: 'claude-code',
    cwd: '/source',
    title: 'caller',
    source: 'sdk',
    lifecycle: 'active',
    activity: 'working',
    startedAt: 1,
    lastEventAt: 2,
    endedAt: null,
    archivedAt: null,
    cliSessionId: 'native-caller',
    ...overrides,
  };
}

function adapter(overrides: Partial<AgentAdapter> = {}): AgentAdapter {
  return {
    id: 'claude-code',
    displayName: 'Claude Code',
    capabilities: {
      canCreateSession: true,
      canForkSession: true,
      canInterrupt: true,
      canSendMessage: true,
      canInstallHooks: true,
      canRespondPermission: true,
      canSetPermissionMode: true,
      canRestartWithPermissionMode: true,
      canRestartWithCodexSandbox: false,
      canRestartWithClaudeCodeSandbox: true,
      canCloseSession: true,
      canCollaborate: true,
      canAcceptAttachments: true,
    },
    init: vi.fn(async () => undefined),
    shutdown: vi.fn(async () => undefined),
    validateForkSession: vi.fn(async () => undefined),
    createForkedSession: vi.fn(async () => ({
      sessionId: 'child',
      discard: vi.fn(async () => undefined),
    })),
    ...overrides,
  };
}

const target: CreateSessionOptions = {
  agentId: 'claude-code',
  cwd: '/target',
  prompt: 'delegate',
};

function parseError(result: Awaited<ReturnType<typeof validateSpawnForkPreflight>>): {
  error: string;
  hint: string;
} {
  expect(result.ok).toBe(false);
  if (result.ok) throw new Error('expected preflight failure');
  return JSON.parse(result.result.content[0].text) as { error: string; hint: string };
}

describe('spawn fork preflight', () => {
  it('returns provider-neutral source after same-adapter same-realpath validation', async () => {
    const a = adapter();
    const realpath = vi.fn(async () => '/canonical/repo');
    const result = await validateSpawnForkPreflight(
      { callerSessionId: 'caller', caller: caller(), adapter: a, target },
      { realpath },
    );

    expect(result).toEqual({
      ok: true,
      source: {
        applicationSessionId: 'caller',
        nativeSessionId: 'native-caller',
        cwd: '/source',
      },
    });
    expect(a.validateForkSession).toHaveBeenCalledWith(result.ok ? result.source : null, target);
    expect(realpath).toHaveBeenCalledTimes(2);
  });

  it.each([
    ['missing', null, /missing caller session/],
    ['hook-only', caller({ source: 'cli' }), /requires an in-app SDK caller/],
    ['archived', caller({ archivedAt: 3 }), /archived caller session/],
    ['dormant', caller({ lifecycle: 'dormant' }), /dormant caller session/],
    ['closed', caller({ lifecycle: 'closed' }), /closed caller session/],
    ['uninitialized', caller({ cliSessionId: null }), /no resumable provider session ID/],
  ])('rejects %s callers before provider validation', async (_name, source, message) => {
    const a = adapter();
    const result = await validateSpawnForkPreflight(
      { callerSessionId: 'caller', caller: source, adapter: a, target },
      { realpath: async (path) => path },
    );

    const parsed = parseError(result);
    expect(parsed.error).toMatch(message);
    expect(parsed.hint).toContain('contextMode "fresh"');
    expect(a.validateForkSession).not.toHaveBeenCalled();
  });

  it('rejects cross-adapter targets with an exact correction', async () => {
    const a = adapter();
    const result = await validateSpawnForkPreflight(
      {
        callerSessionId: 'caller',
        caller: caller({ agentId: 'codex-cli' }),
        adapter: a,
        target,
      },
      { realpath: async (path) => path },
    );

    const parsed = parseError(result);
    expect(parsed.error).toContain('requires caller adapter "codex-cli", received "claude-code"');
    expect(parsed.hint).toContain('adapter "codex-cli"');
  });

  it.each([
    ['capability', (a: AgentAdapter) => { a.capabilities.canForkSession = false; }],
    ['validation hook', (a: AgentAdapter) => { a.validateForkSession = undefined; }],
    ['creation hook', (a: AgentAdapter) => { a.createForkedSession = undefined; }],
  ])('requires native-fork %s', async (_name, disable) => {
    const a = adapter();
    disable(a);
    const result = await validateSpawnForkPreflight(
      { callerSessionId: 'caller', caller: caller(), adapter: a, target },
      { realpath: async () => '/canonical/repo' },
    );

    const parsed = parseError(result);
    expect(parsed.error).toContain('does not provide native session fork support');
    expect(parsed.hint).toContain('contextMode "fresh"');
  });

  it('rejects cross-realpath cwd and suggests the caller cwd', async () => {
    const result = await validateSpawnForkPreflight(
      { callerSessionId: 'caller', caller: caller(), adapter: adapter(), target },
      { realpath: async (path) => (path === '/source' ? '/real/source' : '/real/target') },
    );

    const parsed = parseError(result);
    expect(parsed.error).toContain('must resolve to the same directory');
    expect(parsed.hint).toContain('cwd "/source"');
  });

  it('rejects unresolvable cwd without falling back to lexical paths', async () => {
    const result = await validateSpawnForkPreflight(
      { callerSessionId: 'caller', caller: caller(), adapter: adapter(), target },
      { realpath: async () => { throw new Error('ENOENT'); } },
    );

    const parsed = parseError(result);
    expect(parsed.error).toContain('Cannot resolve fork cwd: ENOENT');
    expect(parsed.hint).toContain('existing directory');
  });

  it('preserves provider validation diagnostics and adds the fork correction', async () => {
    const a = adapter({
      validateForkSession: vi.fn(async () => {
        throw new Error('DeepSeek transcript root is incompatible');
      }),
    });
    const result = await validateSpawnForkPreflight(
      { callerSessionId: 'caller', caller: caller(), adapter: a, target },
      { realpath: async () => '/canonical/repo' },
    );

    const parsed = parseError(result);
    expect(parsed.error).toBe('DeepSeek transcript root is incompatible');
    expect(parsed.hint).toContain('native-fork condition');
    expect(parsed.hint).toContain('contextMode "fresh"');
  });
});
