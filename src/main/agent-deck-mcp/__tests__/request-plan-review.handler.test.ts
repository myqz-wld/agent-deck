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
import { requestPlanReviewHandler } from '../tools/handlers/request-plan-review';
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

describe('request_plan_review handler', () => {
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
      planReviewService.respond('codex-1', event.payload.requestId, {
        decision: 'approve',
        targetMode: 'default',
      }),
    ).toBe(true);

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
      planReviewService.respond('codex-1', requestId, {
        decision: 'keep-planning',
        feedback: '  tighten validation  ',
      }),
    ).toBe(true);

    const result = await pending;
    expect(parseResult(result)).toEqual({
      decision: 'revise',
      feedback: 'tighten validation',
    });
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
      error: expect.stringMatching(/request_plan_review not allowed for external caller/),
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
    expect(parseResult(result)).toEqual({ error: 'ingest failed' });
    expect(planReviewService.listPending('codex-1')).toEqual([]);
  });
});
