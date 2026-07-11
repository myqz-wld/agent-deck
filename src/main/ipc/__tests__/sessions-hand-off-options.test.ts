import { describe, expect, it } from 'vitest';
import type { SessionRecord } from '@shared/types';
import type { CreateSessionOptions } from '@main/adapters/types';
import { buildHandOffCreateSessionOpts } from '../sessions-hand-off-helper';

function makeSession(overrides: Partial<SessionRecord> = {}): SessionRecord {
  return {
    id: 'sid-1',
    agentId: 'claude-code',
    cwd: '/Users/test/project',
    title: 'fake',
    source: 'sdk',
    lifecycle: 'active',
    activity: 'idle',
    startedAt: 0,
    lastEventAt: 0,
    endedAt: null,
    archivedAt: null,
    spawnedBy: null,
    spawnDepth: 0,
    ...overrides,
  } as SessionRecord;
}

describe('buildHandOffCreateSessionOpts — target runtime and sandbox inheritance', () => {
  it('writes hand-off lineage and canonical-id constraints without empty runtime fields', () => {
    const opts = buildHandOffCreateSessionOpts(makeSession(), 'continue from prev');

    expect(opts).toEqual({
      agentId: 'claude-code',
      cwd: '/Users/test/project',
      prompt: 'continue from prev',
      handOff: { mode: 'session', fromCallerSid: 'sid-1', sourceMaxEventId: null },
      awaitCanonicalId: true,
    });
    expect('permissionMode' in opts).toBe(false);
    expect('codexSandbox' in opts).toBe(false);
    expect('claudeCodeSandbox' in opts).toBe(false);
  });

  it('passes the source permission mode to a same-adapter Claude successor', () => {
    const opts = buildHandOffCreateSessionOpts(
      makeSession({ permissionMode: 'acceptEdits' }),
      'continue',
    ) as Extract<CreateSessionOptions, { agentId: 'claude-code' }>;

    expect(opts.permissionMode).toBe('acceptEdits');
  });

  it('passes the source Codex sandbox to a same-adapter Codex successor', () => {
    const opts = buildHandOffCreateSessionOpts(
      makeSession({ agentId: 'codex-cli', codexSandbox: 'read-only' }),
      'continue',
    ) as Extract<CreateSessionOptions, { agentId: 'codex-cli' }>;

    expect(opts.codexSandbox).toBe('read-only');
  });

  it('passes the source Claude sandbox to a same-adapter Claude successor', () => {
    const opts = buildHandOffCreateSessionOpts(
      makeSession({ claudeCodeSandbox: 'strict' }),
      'continue',
    ) as Extract<CreateSessionOptions, { agentId: 'claude-code' }>;

    expect(opts.claudeCodeSandbox).toBe('strict');
  });

  it('filters Codex-only fields from a Claude successor', () => {
    const opts = buildHandOffCreateSessionOpts(
      makeSession({
        permissionMode: 'plan',
        codexSandbox: 'workspace-write',
        claudeCodeSandbox: 'workspace-write',
      }),
      'continue work',
    );

    expect(opts).toEqual({
      agentId: 'claude-code',
      cwd: '/Users/test/project',
      prompt: 'continue work',
      permissionMode: 'plan',
      claudeCodeSandbox: 'workspace-write',
      handOff: { mode: 'session', fromCallerSid: 'sid-1', sourceMaxEventId: null },
      awaitCanonicalId: true,
    });
    expect('codexSandbox' in opts).toBe(false);
  });

  it('filters Claude-only fields from a Codex successor', () => {
    const opts = buildHandOffCreateSessionOpts(
      makeSession({
        agentId: 'codex-cli',
        permissionMode: 'plan',
        codexSandbox: 'workspace-write',
        claudeCodeSandbox: 'strict',
      }),
      'continue work',
    );

    expect(opts).toEqual({
      agentId: 'codex-cli',
      cwd: '/Users/test/project',
      prompt: 'continue work',
      codexSandbox: 'workspace-write',
      handOff: { mode: 'session', fromCallerSid: 'sid-1', sourceMaxEventId: null },
      awaitCanonicalId: true,
    });
    expect('permissionMode' in opts).toBe(false);
    expect('claudeCodeSandbox' in opts).toBe(false);
  });

  it('omits nullable runtime fields so the adapter can apply defaults', () => {
    const opts = buildHandOffCreateSessionOpts(
      makeSession({
        permissionMode: undefined,
        codexSandbox: null,
        claudeCodeSandbox: null,
      }),
      'continue',
    );

    expect('permissionMode' in opts).toBe(false);
    expect('codexSandbox' in opts).toBe(false);
    expect('claudeCodeSandbox' in opts).toBe(false);
  });

  it('preserves an explicit default permission mode', () => {
    const opts = buildHandOffCreateSessionOpts(
      makeSession({ permissionMode: 'default' }),
      'continue',
    ) as Extract<CreateSessionOptions, { agentId: 'claude-code' }>;

    expect(opts.permissionMode).toBe('default');
  });

  it('passes cross-adapter model/thinking without inheriting the source sandbox', () => {
    const opts = buildHandOffCreateSessionOpts(
      makeSession({
        model: 'sonnet',
        thinking: 'high',
        permissionMode: 'plan',
        claudeCodeSandbox: 'strict',
      }),
      'continue',
      { adapter: 'codex-cli', model: 'gpt-custom', thinking: 'ultra' },
      42,
    ) as Extract<CreateSessionOptions, { agentId: 'codex-cli' }>;

    expect(opts).toMatchObject({
      agentId: 'codex-cli',
      model: 'gpt-custom',
      modelReasoningEffort: 'ultra',
      handOff: { mode: 'session', fromCallerSid: 'sid-1', sourceMaxEventId: 42 },
      awaitCanonicalId: true,
    });
    expect('permissionMode' in opts).toBe(false);
    expect('claudeCodeSandbox' in opts).toBe(false);
  });
});
