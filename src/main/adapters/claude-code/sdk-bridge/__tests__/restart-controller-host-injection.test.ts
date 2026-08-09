import { describe, expect, it, vi } from 'vitest';
import type { CapturedRecoveryContinuation } from '@main/session/continuation-context/recovery';
import type { SessionRecord } from '@shared/types';
import { RestartController, type RestartCtx } from '../restart-controller';

const SESSION_ID = 'restart-session';

function record(): SessionRecord {
  return {
    id: SESSION_ID,
    cwd: '/repo',
    cliSessionId: 'claude-cli-session',
    permissionMode: 'default',
    claudeCodeSandbox: 'workspace-write',
    lastEventAt: 10,
  } as SessionRecord;
}

function capture(): CapturedRecoveryContinuation {
  return {
    sourceSessionId: SESSION_ID,
    spoolId: 'spool',
    generator: {},
    target: {},
    rawRetentionCeilingTokens: 1,
  } as CapturedRecoveryContinuation;
}

function context(options: {
  captureError?: Error;
  cleanupError?: Error;
  warn: ReturnType<typeof vi.fn>;
}): RestartCtx {
  return {
    recovering: new Map(),
    sessionHost: {
      readSession: () => record(),
      setPermissionModeAndPublish: vi.fn(),
      setSandboxAndPublish: vi.fn(),
      subscribeRenames: () => vi.fn(),
      warn: options.warn,
    },
    emit: vi.fn(),
    closeSession: async () => undefined,
    createSession: async () => ({ sessionId: SESSION_ID, abort: vi.fn() }),
    jsonlExistsThunk: () => true,
    jsonlMtimeMsThunk: () => 20,
    latestConversationMessageTsThunk: () => null,
    captureRecoveryContinuation: () => {
      if (options.captureError) throw options.captureError;
      return capture();
    },
    prepareRecoveryContinuation: vi.fn(),
    cleanupRecoveryContinuation: () => {
      if (options.cleanupError) throw options.cleanupError;
    },
  };
}

describe('Claude restart diagnostic host injection', () => {
  it('observes capture failure without changing a native restart', async () => {
    const failure = new Error('capture failed');
    const warn = vi.fn(() => {
      throw new Error('observer failed');
    });

    await expect(
      new RestartController(context({ captureError: failure, warn }))
        .restartWithPermissionMode(SESSION_ID, 'plan', 'continue'),
    ).resolves.toBe(SESSION_ID);

    expect(warn).toHaveBeenCalledWith(
      `[claude-restart] continuation capture failed for ${SESSION_ID}`,
      failure,
    );
  });

  it('observes cleanup failure without changing a completed sandbox restart', async () => {
    const failure = new Error('cleanup failed');
    const warn = vi.fn(() => {
      throw new Error('observer failed');
    });

    await expect(
      new RestartController(context({ cleanupError: failure, warn }))
        .restartWithClaudeCodeSandbox(SESSION_ID, 'strict', 'continue'),
    ).resolves.toBe(SESSION_ID);

    expect(warn).toHaveBeenCalledWith(
      `[claude-restart] continuation cleanup failed for ${SESSION_ID}`,
      failure,
    );
  });
});
