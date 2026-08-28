import { describe, expect, it, vi } from 'vitest';
import { CLAUDE_DEFAULT_BUCKET } from '@shared/model-normalize';

import { makeInternalSession } from './types';
import {
  claudeCompactFailureTextCore,
  resolveClaudeFallbackModelCore,
  syncClaudeReportedPermissionModeCore,
  type ClaudeMessageTranslationStateHost,
  type ClaudeMessageTranslationStateRecord,
} from './message-translation-state-core';

function host(
  records: Record<string, ClaudeMessageTranslationStateRecord | null> = {},
): ClaudeMessageTranslationStateHost & {
  setPermissionMode: ReturnType<typeof vi.fn>;
  publishUpdated: ReturnType<typeof vi.fn>;
} {
  return {
    read: (sessionId) => records[sessionId] ?? null,
    setPermissionMode: vi.fn((sessionId: string, mode: string) => {
      records[sessionId] = { ...records[sessionId], permissionMode: mode };
    }),
    publishUpdated: vi.fn(),
  };
}

describe('Claude message translation state Core', () => {
  it('resolves the application model before the translated session fallback', () => {
    const internal = makeInternalSession({
      cwd: '/workspace',
      applicationSid: 'application-a',
    });
    const stateHost = host({
      'application-a': { model: 'claude-opus-4-8' },
      'session-a': { model: 'claude-haiku-4-5' },
    });

    expect(resolveClaudeFallbackModelCore(internal, 'session-a', stateHost)).toBe(
      'claude-opus-4-8',
    );
  });

  it('preserves blank application-model and read-failure fallback semantics', () => {
    const internal = makeInternalSession({
      cwd: '/workspace',
      applicationSid: 'application-b',
    });
    expect(
      resolveClaudeFallbackModelCore(
        internal,
        'session-b',
        host({
          'application-b': { model: '   ' },
          'session-b': { model: 'claude-sonnet-4-6' },
        }),
      ),
    ).toBe(CLAUDE_DEFAULT_BUCKET);
    expect(
      resolveClaudeFallbackModelCore(internal, 'session-b', {
        ...host(),
        read: () => {
          throw new Error('store unavailable');
        },
      }),
    ).toBe(CLAUDE_DEFAULT_BUCKET);
  });

  it('updates the live cache before persistence and publishes only changed records', () => {
    const internal = makeInternalSession({
      cwd: '/workspace',
      applicationSid: 'application-c',
      permissionMode: 'plan',
    });
    const records = { 'session-c': { permissionMode: 'plan' } };
    const stateHost = host(records);

    syncClaudeReportedPermissionModeCore(
      internal,
      'session-c',
      'dontAsk',
      stateHost,
    );

    expect(internal.permissionMode).toBe('dontAsk');
    expect(stateHost.setPermissionMode).toHaveBeenCalledWith('session-c', 'dontAsk');
    expect(stateHost.publishUpdated).toHaveBeenCalledWith('session-c');

    stateHost.setPermissionMode.mockClear();
    stateHost.publishUpdated.mockClear();
    syncClaudeReportedPermissionModeCore(
      internal,
      'session-c',
      'dontAsk',
      stateHost,
    );
    expect(stateHost.setPermissionMode).not.toHaveBeenCalled();
    expect(stateHost.publishUpdated).not.toHaveBeenCalled();
  });

  it('retains bypass over the SDK default and rejects unknown modes', () => {
    const internal = makeInternalSession({
      cwd: '/workspace',
      applicationSid: 'application-d',
      permissionMode: 'bypassPermissions',
    });
    const stateHost = host({ 'session-d': { permissionMode: 'bypassPermissions' } });

    syncClaudeReportedPermissionModeCore(internal, 'session-d', 'default', stateHost);
    syncClaudeReportedPermissionModeCore(internal, 'session-d', 'typo', stateHost);

    expect(internal.permissionMode).toBe('bypassPermissions');
    expect(stateHost.setPermissionMode).not.toHaveBeenCalled();
    expect(stateHost.publishUpdated).not.toHaveBeenCalled();
  });

  it('projects only failed compaction status with bounded fallback text', () => {
    expect(claudeCompactFailureTextCore({ compact_result: 'success' })).toBeNull();
    expect(
      claudeCompactFailureTextCore({
        compact_result: 'failed',
        compact_error: '  provider stopped  ',
      }),
    ).toBe('Claude /compact 失败：provider stopped');
    expect(claudeCompactFailureTextCore({ compact_result: 'failed' })).toBe(
      'Claude /compact 失败：unknown error',
    );
  });
});
