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
import { eventBus } from '@main/event-bus';
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
        instructions: 'Confirm the renamed field is still nullable-safe.',
        rationale: 'Shows the user field rename before applying it.',
        annotations: [
          {
            pane: 'after',
            line: 1,
            title: 'Rename reason',
            body: 'The new path matches the API payload shape.',
          },
        ],
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
      instructions: 'Confirm the renamed field is still nullable-safe.',
      rationale: 'Shows the user field rename before applying it.',
      annotations: [
        {
          pane: 'after',
          line: 1,
          title: 'Rename reason',
          body: 'The new path matches the API payload shape.',
        },
      ],
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

  it('resolves timeout and emits cancellation when the owning session closes', async () => {
    mocks.sessions.set('codex-1', makeSession('codex-1'));

    const pending = requestDiffReviewHandler(
      {
        mode: 'pr',
        rationale: 'Review before shutdown.',
        pr: { before: 'a', after: 'b' },
      },
      makeCtx('codex-1'),
    );

    await vi.waitFor(() => expect(mocks.ingest).toHaveBeenCalledTimes(1));
    const requestId = mocks.ingest.mock.calls[0][0].payload.requestId;

    eventBus.emit('session-upserted', makeSession('codex-1', { lifecycle: 'closed' }));

    const result = await pending;
    expect(parseResult(result)).toEqual({ decision: 'timeout' });
    expect(diffReviewService.listPending('codex-1')).toEqual([]);
    expect(mocks.ingest).toHaveBeenCalledTimes(2);
    expect(mocks.ingest.mock.calls[1][0]).toMatchObject({
      sessionId: 'codex-1',
      agentId: 'codex-cli',
      kind: 'waiting-for-user',
      payload: { type: 'diff-review-cancelled', requestId },
    });
  });

  it('resolves timeout without writing cancellation when the owning session is removed', async () => {
    mocks.sessions.set('codex-1', makeSession('codex-1'));

    const pending = requestDiffReviewHandler(
      {
        mode: 'pr',
        rationale: 'Review before deletion.',
        pr: { before: 'a', after: 'b' },
      },
      makeCtx('codex-1'),
    );

    await vi.waitFor(() => expect(mocks.ingest).toHaveBeenCalledTimes(1));

    eventBus.emit('session-removed', 'codex-1');

    const result = await pending;
    expect(parseResult(result)).toEqual({ decision: 'timeout' });
    expect(diffReviewService.listPending('codex-1')).toEqual([]);
    expect(mocks.ingest).toHaveBeenCalledTimes(1);
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
      hint: 'Remove conflict; use only pr when mode="pr".',
    });
    expect(mocks.ingest).not.toHaveBeenCalled();
  });

  it('rejects annotation panes that do not match the selected mode', async () => {
    mocks.sessions.set('codex-1', makeSession('codex-1'));

    const result = await requestDiffReviewHandler(
      {
        mode: 'pr',
        rationale: 'Invalid annotation pane.',
        annotations: [{ pane: 'resolution', line: 1, body: 'This belongs to conflict mode.' }],
        pr: { before: 'a', after: 'b' },
      },
      makeCtx('codex-1'),
    );

    expect(result.isError).toBe(true);
    expect(parseResult(result)).toEqual({
      error: 'present_diff annotation pane "resolution" is not valid when mode="pr"',
      hint: 'Use annotation.pane "before", "after", or "both".',
    });
    expect(mocks.ingest).not.toHaveBeenCalled();
  });

  it('rejects base annotations when no base pane is presented', async () => {
    mocks.sessions.set('codex-1', makeSession('codex-1'));

    const result = await requestDiffReviewHandler(
      {
        mode: 'merge-conflict',
        rationale: 'Invalid base annotation.',
        annotations: [{ pane: 'base', line: 1, body: 'No base pane exists.' }],
        conflict: { ours: 'a', theirs: 'b', resolution: 'c' },
      },
      makeCtx('codex-1'),
    );

    expect(result.isError).toBe(true);
    expect(parseResult(result)).toEqual({
      error: 'present_diff annotation pane "base" requires conflict.base',
      hint: 'Add conflict.base, remove the base annotation, or change its pane.',
    });
    expect(mocks.ingest).not.toHaveBeenCalled();
  });

  it('returns exact correction shapes for the remaining mode and annotation mismatches', async () => {
    mocks.sessions.set('codex-1', makeSession('codex-1'));
    const cases: Array<{
      args: Parameters<typeof requestDiffReviewHandler>[0];
      error: string;
      hint: string;
    }> = [
      {
        args: { mode: 'pr', rationale: 'Missing PR payload.' },
        error: 'present_diff requires `pr` when mode="pr"',
        hint: 'Set pr={before,after}; omit conflict.',
      },
      {
        args: { mode: 'merge-conflict', rationale: 'Missing conflict payload.' },
        error: 'present_diff requires `conflict` when mode="merge-conflict"',
        hint: 'Set conflict={ours,theirs,resolution[,base]}; omit pr.',
      },
      {
        args: {
          mode: 'merge-conflict',
          rationale: 'Mixed payload.',
          pr: { before: 'a', after: 'b' },
          conflict: { ours: 'a', theirs: 'b', resolution: 'c' },
        },
        error: 'present_diff rejects `pr` when mode="merge-conflict"',
        hint: 'Remove pr; use only conflict when mode="merge-conflict".',
      },
      {
        args: {
          mode: 'merge-conflict',
          rationale: 'Invalid annotation.',
          annotations: [{ pane: 'after', line: 1, body: 'Wrong pane.' }],
          conflict: { ours: 'a', theirs: 'b', resolution: 'c' },
        },
        error: 'present_diff annotation pane "after" is not valid when mode="merge-conflict"',
        hint: 'Use annotation.pane "base", "ours", "theirs", or "resolution".',
      },
    ];

    for (const testCase of cases) {
      const result = await requestDiffReviewHandler(testCase.args, makeCtx('codex-1'));
      expect(parseResult(result)).toEqual({
        error: testCase.error,
        hint: testCase.hint,
      });
    }
    expect(mocks.ingest).not.toHaveBeenCalled();
  });

  it('returns exact recovery actions when the caller session is unavailable or closed', async () => {
    const missing = await requestDiffReviewHandler(
      { mode: 'pr', rationale: 'Missing caller.', pr: { before: 'a', after: 'b' } },
      makeCtx('missing-caller'),
    );
    expect(parseResult(missing)).toEqual({
      error: 'caller session "missing-caller" not in sessions table — cannot display diff review',
      hint: 'Retry once after session initialization completes. If it persists, stop; present_diff requires a live Agent Deck session.',
    });

    mocks.sessions.set('closed-caller', makeSession('closed-caller', { lifecycle: 'closed' }));
    const closed = await requestDiffReviewHandler(
      { mode: 'pr', rationale: 'Closed caller.', pr: { before: 'a', after: 'b' } },
      makeCtx('closed-caller'),
    );
    expect(parseResult(closed)).toEqual({
      error: 'caller session "closed-caller" is closed',
      hint: 'Do not retry. Ask the user to start a new Agent Deck session and present the diff there.',
    });
    expect(mocks.ingest).not.toHaveBeenCalled();
  });

  it('preserves service errors and returns a bounded retry action', async () => {
    mocks.sessions.set('codex-1', makeSession('codex-1'));
    mocks.ingest.mockImplementationOnce(() => {
      throw new Error('diff ingest failed');
    });

    const result = await requestDiffReviewHandler(
      { mode: 'pr', rationale: 'Service failure.', pr: { before: 'a', after: 'b' } },
      makeCtx('codex-1'),
    );

    expect(parseResult(result)).toEqual({
      error: 'diff ingest failed',
      hint: 'Retry present_diff once. If it fails again, stop and inspect Agent Deck main-process logs.',
    });
    expect(diffReviewService.listPending('codex-1')).toEqual([]);
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
