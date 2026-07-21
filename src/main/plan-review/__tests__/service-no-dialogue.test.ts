import { expect, it, vi } from 'vitest';
import type { SessionRecord } from '@shared/types';
import type { PlanReviewSessionCoordinator } from '../deep-review-session';
import { PlanReviewService } from '../service';

function sourceSession(): SessionRecord {
  return {
    id: 'source',
    agentId: 'codex-cli',
    cwd: '/repo',
    title: 'Source',
    source: 'sdk',
    lifecycle: 'active',
    activity: 'waiting',
    startedAt: 1,
    lastEventAt: 1,
    endedAt: null,
    archivedAt: null,
  };
}

it('returns editable no-op feedback without a fork or LLM when no question was sent', async () => {
  const start = vi.fn<PlanReviewSessionCoordinator['start']>();
  const generateFeedback = vi.fn<PlanReviewSessionCoordinator['generateFeedback']>();
  const coordinator: PlanReviewSessionCoordinator = {
    start,
    ask: vi.fn(),
    generateFeedback,
    deliverLateDecision: vi.fn(),
    close: vi.fn(),
  };
  const service = new PlanReviewService({
    createRequestId: () => 'request-1',
    ingest: vi.fn(),
    getSession: sourceSession,
    coordinator,
  });
  void service.request({
    sessionId: 'source',
    agentId: 'codex-cli',
    plan: 'Plan',
  });

  await expect(service.generateFeedbackDraft('source', 'request-1'))
    .resolves.toBe('尚未进行审阅对话，暂无修改意见。');
  expect(start).not.toHaveBeenCalled();
  expect(generateFeedback).not.toHaveBeenCalled();
  expect(service.listPending('source')).toHaveLength(1);
});
