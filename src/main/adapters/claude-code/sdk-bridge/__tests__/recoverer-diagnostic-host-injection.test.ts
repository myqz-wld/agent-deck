import { describe, expect, it, vi } from 'vitest';
import type { CapturedRecoveryContinuation } from '@main/session/continuation-context/recovery';
import type { SessionRecord } from '@shared/types';
import { recoverAndSendImpl } from '../recoverer/recover-and-send-impl';
import type { RecoverAndSendDeps } from '../recoverer/_deps';

const SESSION_ID = 'recovery-session';

function record(): SessionRecord {
  return {
    id: SESSION_ID,
    agentId: 'claude-code',
    cwd: '/repo',
    title: 'Recovery session',
    source: 'sdk',
    lifecycle: 'dormant',
    activity: 'idle',
    startedAt: 1,
    lastEventAt: 2,
    endedAt: null,
    archivedAt: null,
  } as SessionRecord;
}

function capture(): CapturedRecoveryContinuation {
  return {
    sourceSessionId: SESSION_ID,
    spoolId: 'recovery-spool',
    generator: {},
    target: {},
    rawRetentionCeilingTokens: 1,
  } as CapturedRecoveryContinuation;
}

function dependencies(options: {
  captureError?: Error;
  cleanupError?: Error;
  warn: ReturnType<typeof vi.fn>;
}): RecoverAndSendDeps {
  return {
    ctx: {
      recovering: new Map(),
      emit: vi.fn(),
      sessionReader: { readPersistedSession: () => record() },
      sessionManager: {
        getCloseEpoch: () => 0,
        markClosed: vi.fn(),
        unarchive: vi.fn(async () => undefined),
      },
    },
    createThunk: async () => ({ sessionId: SESSION_ID, abort: vi.fn() }),
    sendThunk: vi.fn(async () => undefined),
    jsonlExistsThunk: () => true,
    jsonlMtimeMsThunk: () => 10,
    cwdExistsThunk: () => true,
    latestConversationMessageTsThunk: () => null,
    warn: options.warn,
    captureRecoveryContinuation: () => {
      if (options.captureError) throw options.captureError;
      return capture();
    },
    prepareRecoveryContinuation: async () => {
      throw new Error('native resume must not prepare fallback context');
    },
    cleanupRecoveryContinuation: () => {
      if (options.cleanupError) throw options.cleanupError;
    },
    findFallbackCwdThunk: () => null,
    emitFallbackMessageThunk: vi.fn(),
    placeholderEmittedAt: new Map(),
  };
}

describe('Claude recoverer diagnostic host injection', () => {
  it('keeps native recovery authoritative when capture diagnostics throw', async () => {
    const failure = new Error('capture failed');
    const warn = vi.fn(() => {
      throw new Error('observer failed');
    });

    await expect(
      recoverAndSendImpl(SESSION_ID, 'continue', undefined, undefined, dependencies({
        captureError: failure,
        warn,
      })),
    ).resolves.toBe(SESSION_ID);

    expect(warn).toHaveBeenCalledWith(
      `[sdk-bridge] recovery continuation capture failed for ${SESSION_ID}`,
      failure,
    );
  });

  it('keeps completed recovery authoritative when cleanup diagnostics throw', async () => {
    const failure = new Error('cleanup failed');
    const warn = vi.fn(() => {
      throw new Error('observer failed');
    });

    await expect(
      recoverAndSendImpl(SESSION_ID, 'continue', undefined, undefined, dependencies({
        cleanupError: failure,
        warn,
      })),
    ).resolves.toBe(SESSION_ID);

    expect(warn).toHaveBeenCalledWith(
      `[sdk-bridge] recovery continuation cleanup failed for ${SESSION_ID}`,
      failure,
    );
  });
});
