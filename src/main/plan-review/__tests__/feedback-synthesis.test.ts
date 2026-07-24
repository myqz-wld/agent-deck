import { describe, expect, it, vi } from 'vitest';
import {
  NO_PLAN_REVIEW_DIALOGUE_FEEDBACK,
  type AgentEvent,
  type SessionRecord,
} from '@shared/types';
import {
  buildPostForkReviewDialogue,
  synthesizePlanReviewFeedback,
  type PlanReviewFeedbackSynthesisDeps,
} from '../feedback-synthesis';

function event(
  ts: number,
  role: 'user' | 'assistant',
  text: string,
  error = false,
): AgentEvent {
  return {
    sessionId: 'child',
    agentId: 'codex-cli',
    kind: 'message',
    payload: { role, text, ...(error ? { error: true } : {}) },
    ts,
    source: 'sdk',
  };
}

function session(overrides: Partial<SessionRecord> = {}): SessionRecord {
  return {
    id: 'child',
    agentId: 'codex-cli',
    cwd: '/repo',
    title: 'Review child',
    source: 'sdk',
    lifecycle: 'active',
    activity: 'idle',
    startedAt: 1,
    lastEventAt: 1,
    endedAt: null,
    archivedAt: null,
    model: 'gpt-review',
    thinking: 'high',
    ...overrides,
  };
}

const request = {
  type: 'exit-plan-mode' as const,
  requestId: 'plan-1',
  reviewSource: 'mcp' as const,
  title: 'Lifecycle plan',
  plan: '1. Preserve the queue.\n2. Validate cancellation.',
};

describe('plan review feedback synthesis', () => {
  it('keeps only real post-fork dialogue in chronological order', () => {
    const newestFirst = [
      event(6, 'user', 'Does deletion race safely?'),
      event(5, 'assistant', 'provider error', true),
      event(4, 'assistant', 'Add an atomic removal test.'),
      event(3, 'user', 'What is missing?'),
      event(2, 'assistant', 'The plan review is ready.'),
      event(1, 'user', '<!-- agent-deck-plan-review-internal:setup:plan-1 --> setup'),
    ];

    expect(buildPostForkReviewDialogue(newestFirst)).toBe(
      'User:\nWhat is missing?\n\n' +
      'Reviewer:\nAdd an atomic removal test.\n\n' +
      'User:\nDoes deletion race safely?',
    );
  });

  it('runs a fresh Codex one-shot from the plan and child dialogue only', async () => {
    const runCodex = vi.fn<PlanReviewFeedbackSynthesisDeps['runCodex']>(
      async () => '  Add an atomic deletion check.  ',
    );
    const runClaude = vi.fn<PlanReviewFeedbackSynthesisDeps['runClaude']>(
      async () => 'must not run',
    );
    const listEvents = vi.fn(() => [
      event(4, 'assistant', 'Deletion must be atomic.'),
      event(3, 'user', 'Review deletion.'),
    ]);
    const deps = {
      getSession: () => session(),
      listEvents,
      runClaude,
      runCodex,
      resolveClaudeGateway: vi.fn(() => null),
    } as unknown as PlanReviewFeedbackSynthesisDeps;

    await expect(synthesizePlanReviewFeedback({
      runtimeSessionId: 'child',
      dialogueSessionId: 'child',
      agentId: 'codex-cli',
      request,
    }, deps)).resolves.toBe('Add an atomic deletion check.');

    expect(listEvents).toHaveBeenCalledWith('child', 400);
    expect(runClaude).not.toHaveBeenCalled();
    expect(runCodex).toHaveBeenCalledWith(expect.objectContaining({
      cwd: '/repo',
      model: 'gpt-review',
      modelReasoningEffort: 'high',
      systemPrompt: expect.stringContaining('fresh, isolated context'),
      prompt: expect.stringContaining('<current_plan>'),
    }));
    const prompt = runCodex.mock.calls[0]![0].prompt;
    expect(prompt).toContain(request.plan);
    expect(prompt).toContain('User:\nReview deletion.');
    expect(prompt).toContain('Reviewer:\nDeletion must be atomic.');
  });

  it('returns the editable default without an LLM call when the fork has no real question', async () => {
    const runClaude = vi.fn<PlanReviewFeedbackSynthesisDeps['runClaude']>();
    const runCodex = vi.fn<PlanReviewFeedbackSynthesisDeps['runCodex']>();
    const getSession = vi.fn(() => session());
    const deps = {
      getSession,
      listEvents: vi.fn(() => [
        event(2, 'assistant', 'The plan review is ready.'),
        event(1, 'user', '<!-- agent-deck-plan-review-internal:setup:plan-1 --> setup'),
      ]),
      runClaude,
      runCodex,
      resolveClaudeGateway: vi.fn(() => null),
    } as unknown as PlanReviewFeedbackSynthesisDeps;

    await expect(synthesizePlanReviewFeedback({
      runtimeSessionId: 'child',
      dialogueSessionId: 'child',
      agentId: 'codex-cli',
      request,
    }, deps)).resolves.toBe(NO_PLAN_REVIEW_DIALOGUE_FEEDBACK);

    expect(runClaude).not.toHaveBeenCalled();
    expect(runCodex).not.toHaveBeenCalled();
    expect(getSession).not.toHaveBeenCalled();
  });

  it('uses the persisted Claude Gateway profile without creating a session', async () => {
    const runClaude = vi.fn<PlanReviewFeedbackSynthesisDeps['runClaude']>(
      async () => 'Keep the rollback explicit.',
    );
    const runCodex = vi.fn<PlanReviewFeedbackSynthesisDeps['runCodex']>(
      async () => 'must not run',
    );
    const profile = {
      id: 'deepseek',
      settingsPath: '/home/test/.claude/gateways/deepseek.json',
      models: [],
    };
    const deps = {
      getSession: () => session({
        agentId: 'claude-code',
        runtimeProvider: 'deepseek',
        model: 'deepseek-v4-pro',
        thinking: 'xhigh',
      }),
      listEvents: () => [event(3, 'user', 'Review rollback.')],
      runClaude,
      runCodex,
      resolveClaudeGateway: vi.fn(() => profile),
    } as unknown as PlanReviewFeedbackSynthesisDeps;

    await expect(synthesizePlanReviewFeedback({
      runtimeSessionId: 'child',
      dialogueSessionId: 'child',
      agentId: 'claude-code',
      request,
    }, deps)).resolves.toBe('Keep the rollback explicit.');
    expect(runCodex).not.toHaveBeenCalled();
    expect(runClaude).toHaveBeenCalledWith(expect.objectContaining({
      model: 'deepseek-v4-pro',
      effort: 'xhigh',
      settingsPath: profile.settingsPath,
    }));
  });
});
