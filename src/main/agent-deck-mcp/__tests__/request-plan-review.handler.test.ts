import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SessionRecord } from '@shared/types';
import { makeSessionRepoMock } from '@main/__tests__/_shared/mocks/session-repo';

const mocks = vi.hoisted(() => ({
  sessions: new Map<string, SessionRecord>(),
  ingest: vi.fn(),
}));

vi.mock('@main/store/session-repo', () => ({
  sessionRepo: makeSessionRepoMock({ sessions: mocks.sessions }),
}));

vi.mock('@main/session/manager', () => ({
  sessionManager: {
    ingest: mocks.ingest,
  },
}));

import { planReviewService } from '@main/plan-review/service';
import { eventBus } from '@main/event-bus';
import {
  requestPlanReviewHandler,
  resolvePlanReviewTimeoutMs,
} from '../tools/handlers/request-plan-review';
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
});

describe('present_plan handler', () => {
  it('emits an ExitPlanMode-compatible pending review and resolves approved', async () => {
    mocks.sessions.set('codex-1', makeSession('codex-1'));

    const pending = requestPlanReviewHandler(
      { plan: '## Plan\n\n1. Add the tool', title: 'Tool plan' },
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
      type: 'exit-plan-mode',
      reviewSource: 'mcp',
      title: 'Tool plan',
      plan: '## Plan\n\n1. Add the tool',
    });
    expect(String(event.payload.requestId)).toMatch(/^mcp-plan-/);

    expect(planReviewService.listPending('codex-1')).toHaveLength(1);
    expect(
      await planReviewService.respond('codex-1', event.payload.requestId, {
        decision: 'approve',
        targetMode: 'default',
      }),
    ).toBe('codex-1');

    const result = await pending;
    expect(result.isError).toBeFalsy();
    expect(result.content[0].text).toContain('"decision": "approved"');
    expect(planReviewService.listPending('codex-1')).toEqual([]);
  });

  it('maps keep-planning feedback to revise for the MCP caller', async () => {
    mocks.sessions.set('codex-1', makeSession('codex-1'));

    const pending = requestPlanReviewHandler(
      { plan: 'Revise me' },
      makeCtx('codex-1'),
    );

    await vi.waitFor(() => expect(mocks.ingest).toHaveBeenCalledTimes(1));
    const requestId = mocks.ingest.mock.calls[0][0].payload.requestId;
    expect(
      await planReviewService.respond('codex-1', requestId, {
        decision: 'keep-planning',
        feedback: '  tighten validation  ',
      }),
    ).toBe('codex-1');

    const result = await pending;
    expect(parseResult(result)).toEqual({
      decision: 'revise',
      feedback: 'tighten validation',
    });
  });

  it('resolves timeout and emits cancellation when the owning session closes', async () => {
    mocks.sessions.set('codex-1', makeSession('codex-1'));

    const pending = requestPlanReviewHandler(
      { plan: 'Review before shutdown' },
      makeCtx('codex-1'),
    );

    await vi.waitFor(() => expect(mocks.ingest).toHaveBeenCalledTimes(1));
    const requestId = mocks.ingest.mock.calls[0][0].payload.requestId;

    eventBus.emit('session-upserted', makeSession('codex-1', { lifecycle: 'closed' }));

    const result = await pending;
    expect(parseResult(result)).toEqual({ decision: 'timeout' });
    expect(planReviewService.listPending('codex-1')).toEqual([]);
    expect(mocks.ingest).toHaveBeenCalledTimes(2);
    expect(mocks.ingest.mock.calls[1][0]).toMatchObject({
      sessionId: 'codex-1',
      agentId: 'codex-cli',
      kind: 'waiting-for-user',
      payload: { type: 'exit-plan-cancelled', requestId },
    });
  });

  it('waits indefinitely when timeoutMs is omitted', async () => {
    mocks.sessions.set('codex-1', makeSession('codex-1'));
    const requestSpy = vi
      .spyOn(planReviewService, 'request')
      .mockResolvedValue({ decision: 'approved' });

    try {
      const result = await requestPlanReviewHandler(
        { plan: 'Wait for the user' },
        makeCtx('codex-1'),
      );

      expect(result.isError).toBeFalsy();
      expect(parseResult(result)).toEqual({ decision: 'approved' });
      expect(requestSpy.mock.calls[0]?.[0].timeoutMs).toBeUndefined();
    } finally {
      requestSpy.mockRestore();
    }
  });

  it('preserves an explicit timeoutMs', async () => {
    mocks.sessions.set('codex-1', makeSession('codex-1'));
    const requestSpy = vi
      .spyOn(planReviewService, 'request')
      .mockResolvedValue({ decision: 'timeout' });

    try {
      await requestPlanReviewHandler(
        { plan: 'Cap me', timeoutMs: 120_000 },
        makeCtx('codex-1'),
      );

      expect(requestSpy).toHaveBeenCalledWith(
        expect.objectContaining({ timeoutMs: 120_000 }),
      );
    } finally {
      requestSpy.mockRestore();
    }
  });

  it('denies external callers before creating a pending review', async () => {
    const result = await requestPlanReviewHandler(
      { plan: 'External plan' },
      {
        caller: {
          callerSessionId: EXTERNAL_CALLER_SENTINEL,
          transport: 'http',
        },
      },
    );

    expect(result.isError).toBe(true);
    expect(parseResult(result)).toMatchObject({
      error: expect.stringMatching(/present_plan not allowed for external caller/),
    });
    expect(mocks.ingest).not.toHaveBeenCalled();
  });

  it('returns exact recovery actions when the caller session is unavailable or closed', async () => {
    const missing = await requestPlanReviewHandler(
      { plan: 'Missing caller' },
      makeCtx('missing-caller'),
    );
    expect(parseResult(missing)).toEqual({
      error: 'caller session "missing-caller" not in sessions table — cannot display plan review',
      hint: 'Retry once after session initialization completes. If it persists, stop; present_plan requires a live Agent Deck session.',
    });

    mocks.sessions.set('closed-caller', makeSession('closed-caller', { lifecycle: 'closed' }));
    const closed = await requestPlanReviewHandler(
      { plan: 'Closed caller' },
      makeCtx('closed-caller'),
    );
    expect(parseResult(closed)).toEqual({
      error: 'caller session "closed-caller" is closed',
      hint: 'Do not retry. Ask the user to start a new Agent Deck session and present the plan there.',
    });
    expect(mocks.ingest).not.toHaveBeenCalled();
  });

  it('cleans up the pending request if event ingest fails', async () => {
    mocks.sessions.set('codex-1', makeSession('codex-1'));
    mocks.ingest.mockImplementationOnce(() => {
      throw new Error('ingest failed');
    });

    const result = await requestPlanReviewHandler(
      { plan: '## Plan' },
      makeCtx('codex-1'),
    );

    expect(result.isError).toBe(true);
    expect(parseResult(result)).toEqual({
      error: 'ingest failed',
      hint: 'Retry present_plan once. If it fails again, stop and inspect Agent Deck main-process logs.',
    });
    expect(planReviewService.listPending('codex-1')).toEqual([]);
  });
});

describe('resolvePlanReviewTimeoutMs', () => {
  it('uses no timeout when present_plan omits timeoutMs', () => {
    expect(resolvePlanReviewTimeoutMs(undefined)).toBeUndefined();
    expect(resolvePlanReviewTimeoutMs(30_000)).toBe(30_000);
  });

  it('retains the legacy permission cap when present_diff supplies that setting', () => {
    expect(resolvePlanReviewTimeoutMs(30_000, 90_000)).toBe(30_000);
    expect(resolvePlanReviewTimeoutMs(120_000, 90_000)).toBe(90_000);
  });

  it('treats permission timeout 0 as no default cap', () => {
    expect(resolvePlanReviewTimeoutMs(undefined, 0)).toBeUndefined();
    expect(resolvePlanReviewTimeoutMs(30_000, 0)).toBe(30_000);
  });
});
