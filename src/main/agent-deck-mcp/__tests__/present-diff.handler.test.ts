import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SessionRecord } from '@shared/types';
import { makeSessionRepoMock } from '@main/__tests__/_shared/mocks/session-repo';

const mocks = vi.hoisted(() => ({
  sessions: new Map<string, SessionRecord>(),
  ingest: vi.fn(),
  permissionTimeoutMs: 30 * 60 * 1000,
}));

vi.mock('@main/store/session-repo', () => ({
  sessionRepo: makeSessionRepoMock({ sessions: mocks.sessions }),
}));

vi.mock('@main/session/manager', () => ({
  sessionManager: {
    ingest: mocks.ingest,
  },
}));

vi.mock('@main/store/settings-store', () => ({
  settingsStore: {
    get: vi.fn((key: string) => {
      if (key === 'permissionTimeoutMs') return mocks.permissionTimeoutMs;
      return undefined;
    }),
  },
}));

import { diffReviewService } from '@main/diff-review/service';
import { requestDiffReviewHandler } from '../tools/handlers/request-diff-review';
import type { HandlerContext } from '../tools/helpers';
import { EXTERNAL_CALLER_SENTINEL } from '../types';

function makeSession(id: string, overrides: Partial<SessionRecord> = {}): SessionRecord {
  return {
    id,
    agentId: 'codex-cli',
    cwd: '/repo',
    title: 'Codex',
    source: 'sdk',
    lifecycle: 'active',
    activity: 'working',
    startedAt: 1,
    lastEventAt: 1,
    endedAt: null,
    archivedAt: null,
    spawnedBy: null,
    spawnDepth: 0,
    ...overrides,
  };
}

function makeCtx(callerSessionId: string): HandlerContext {
  return { caller: { callerSessionId, transport: 'in-process' } };
}

function parseResult(result: { content: Array<{ text: string }> }): unknown {
  return JSON.parse(result.content[0].text);
}

beforeEach(() => {
  mocks.sessions.clear();
  mocks.ingest.mockReset();
  mocks.permissionTimeoutMs = 30 * 60 * 1000;
});

describe('present_diff handler', () => {
  it('emits a pending PR diff presentation and resolves approved', async () => {
    mocks.sessions.set('codex-1', makeSession('codex-1'));

    const pending = requestDiffReviewHandler(
      {
        mode: 'pr',
        title: 'User fields',
        filePath: 'src/user.ts',
        language: 'typescript',
        rationale: 'Shows the user field rename before applying it.',
        pr: {
          before: 'const name = user.name;',
          after: 'const displayName = user.profile.displayName;',
          beforeLabel: 'before',
          afterLabel: 'after',
        },
      },
      makeCtx('codex-1'),
    );

    await vi.waitFor(() => expect(mocks.ingest).toHaveBeenCalledTimes(1));
    const event = mocks.ingest.mock.calls[0][0];
    expect(event).toMatchObject({
      sessionId: 'codex-1',
      agentId: 'codex-cli',
      kind: 'waiting-for-user',
      source: 'sdk',
    });
    expect(event.payload).toMatchObject({
      type: 'diff-review',
      mode: 'pr',
      title: 'User fields',
      filePath: 'src/user.ts',
      language: 'typescript',
      rationale: 'Shows the user field rename before applying it.',
      pr: {
        before: 'const name = user.name;',
        after: 'const displayName = user.profile.displayName;',
      },
    });
    expect(String(event.payload.requestId)).toMatch(/^mcp-diff-/);

    expect(diffReviewService.listPending('codex-1')).toHaveLength(1);
    expect(
      diffReviewService.respond('codex-1', event.payload.requestId, {
        decision: 'approve',
      }),
    ).toBe(true);

    const result = await pending;
    expect(result.isError).toBeFalsy();
    expect(parseResult(result)).toEqual({ decision: 'approved' });
    expect(diffReviewService.listPending('codex-1')).toEqual([]);
  });

  it('emits a pending conflict presentation and returns revision feedback', async () => {
    mocks.sessions.set('codex-1', makeSession('codex-1'));

    const pending = requestDiffReviewHandler(
      {
        mode: 'merge-conflict',
        title: 'Resolve title conflict',
        rationale: 'Shows the proposed resolution for the title merge conflict.',
        conflict: {
          base: 'title: old',
          ours: 'title: local',
          theirs: 'title: incoming',
          resolution: 'title: local incoming',
        },
      },
      makeCtx('codex-1'),
    );

    await vi.waitFor(() => expect(mocks.ingest).toHaveBeenCalledTimes(1));
    const requestId = mocks.ingest.mock.calls[0][0].payload.requestId;
    expect(
      diffReviewService.respond('codex-1', requestId, {
        decision: 'revise',
        feedback: '  keep the incoming title only  ',
      }),
    ).toBe(true);

    const result = await pending;
    expect(parseResult(result)).toEqual({
      decision: 'revise',
      feedback: 'keep the incoming title only',
    });
  });

  it('rejects mode and payload mismatches before creating a pending presentation', async () => {
    mocks.sessions.set('codex-1', makeSession('codex-1'));

    const result = await requestDiffReviewHandler(
      {
        mode: 'pr',
        rationale: 'Invalid mixed payload.',
        pr: { before: 'a', after: 'b' },
        conflict: { ours: 'a', theirs: 'b', resolution: 'c' },
      },
      makeCtx('codex-1'),
    );

    expect(result.isError).toBe(true);
    expect(parseResult(result)).toEqual({
      error: 'present_diff rejects `conflict` when mode="pr"',
    });
    expect(mocks.ingest).not.toHaveBeenCalled();
  });

  it('passes the permission timeout to the presentation service when timeoutMs is omitted', async () => {
    mocks.sessions.set('codex-1', makeSession('codex-1'));
    mocks.permissionTimeoutMs = 45_000;
    const requestSpy = vi
      .spyOn(diffReviewService, 'request')
      .mockResolvedValue({ decision: 'timeout' });

    try {
      const result = await requestDiffReviewHandler(
        {
          mode: 'pr',
          rationale: 'Use settings timeout.',
          pr: { before: 'a', after: 'b' },
        },
        makeCtx('codex-1'),
      );

      expect(result.isError).toBeFalsy();
      expect(parseResult(result)).toEqual({ decision: 'timeout' });
      expect(requestSpy).toHaveBeenCalledWith(
        expect.objectContaining({ timeoutMs: 45_000 }),
      );
    } finally {
      requestSpy.mockRestore();
    }
  });

  it('denies external callers before creating a pending presentation', async () => {
    const result = await requestDiffReviewHandler(
      {
        mode: 'pr',
        rationale: 'External diff.',
        pr: { before: 'a', after: 'b' },
      },
      {
        caller: {
          callerSessionId: EXTERNAL_CALLER_SENTINEL,
          transport: 'http',
        },
      },
    );

    expect(result.isError).toBe(true);
    expect(parseResult(result)).toMatchObject({
      error: expect.stringMatching(/present_diff not allowed for external caller/),
    });
    expect(mocks.ingest).not.toHaveBeenCalled();
  });
});
