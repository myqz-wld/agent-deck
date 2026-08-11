// @vitest-environment happy-dom
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { MCP_PLAN_PRESENTATION_SCHEMA } from '@contracts/index';
import type { RemotePendingPresentation } from './source-types';
import { RemotePlanReviewTransports } from './remote-plan-review-transports';

const presentation: RemotePendingPresentation = {
  sourceIdentity: 'profile-a:core-a:1',
  revision: 5,
  digest: 'digest-a',
  request: {
    id: 'plan-a',
    sessionId: 'session-a',
    kind: 'exit-plan',
    status: 'pending',
    createdAt: 1,
    expiresAt: null,
    display: { schema: MCP_PLAN_PRESENTATION_SCHEMA, plan: '# Plan' },
  },
};

function context(identity = presentation.sourceIdentity) {
  let current = identity;
  return {
    value: {
      activeProfileId: 'profile-a',
      capabilities: new Set(['plan-review', 'pending.read', 'events.replay']),
      dataRevision: 2,
      identity,
      usable: true,
      currentIdentity: () => current,
    },
    switchIdentity: (next: string) => { current = next; },
  };
}

beforeEach(() => {
  Object.defineProperty(window, 'api', {
    configurable: true,
    value: {
      startRemoteHostPlanReview: vi.fn(async () => ({
        sessionId: 'review-child', agentId: 'codex-cli', revision: 6,
      })),
      askRemoteHostPlanReview: vi.fn(async () => ({ accepted: true, revision: 7 })),
      generateRemoteHostPlanReviewFeedback: vi.fn(async () => ({
        feedback: 'Add a race test.', revision: 8,
      })),
      listRemoteHostEvents: vi.fn(async () => ({
        events: [{
          id: 1, sessionId: 'review-child', agentId: 'codex-cli', kind: 'message',
          payload: { role: 'assistant', text: 'Ready' }, ts: 1,
        }],
        revision: 8,
        truncated: false,
      })),
    },
  });
});

describe('RemotePlanReviewTransports', () => {
  it('keeps the latest Core revision and never calls Local plan-review APIs', async () => {
    const registry = new RemotePlanReviewTransports();
    const source = context();
    const transport = registry.get(source.value, presentation, 'codex-cli')!;
    await expect(transport.start()).resolves.toEqual({
      sessionId: 'review-child', agentId: 'codex-cli',
    });
    await transport.ask('What is missing?');
    await expect(transport.generateFeedback()).resolves.toEqual({ feedback: 'Add a race test.' });
    await expect(transport.listEvents('review-child')).resolves.toHaveLength(1);

    expect(window.api.startRemoteHostPlanReview).toHaveBeenCalledWith(expect.objectContaining({
      profileId: 'profile-a', sessionId: 'session-a', requestId: 'plan-a', expectedRevision: 5,
    }));
    expect(window.api.askRemoteHostPlanReview).toHaveBeenCalledWith(expect.objectContaining({
      question: 'What is missing?', expectedRevision: 6,
    }));
    expect(window.api.generateRemoteHostPlanReviewFeedback).toHaveBeenCalledWith(
      expect.objectContaining({ expectedRevision: 7 }),
    );
    expect((window.api as unknown as { startPlanDeepReview?: unknown }).startPlanDeepReview)
      .toBeUndefined();
  });

  it('fails closed after a source switch and does not offer Grok or incomplete capabilities', async () => {
    const registry = new RemotePlanReviewTransports();
    const source = context();
    const transport = registry.get(source.value, presentation, 'codex-cli')!;
    source.switchIdentity('profile-b:core-b:1');
    await expect(transport.start()).rejects.toThrow('数据源已切换');
    expect(registry.get(source.value, presentation, 'grok-build')).toBeNull();
    expect(registry.get({
      ...source.value,
      capabilities: new Set(['plan-review', 'pending.read']),
    }, presentation, 'codex-cli')).toBeNull();
    expect(registry.get({
      ...source.value,
      usable: false,
    }, presentation, 'codex-cli')).toBeNull();
  });

  it('keeps failed intent capacity isolated per Remote source', async () => {
    const registry = new RemotePlanReviewTransports();
    const sourceA = context();
    const transportA = registry.get(sourceA.value, presentation, 'codex-cli')!;
    vi.mocked(window.api.askRemoteHostPlanReview).mockRejectedValue(new Error('offline'));
    for (let index = 0; index < 64; index += 1) {
      await expect(transportA.ask(`question-${index}`)).rejects.toThrow('offline');
    }

    const identity = 'profile-b:core-b:1';
    const sourceB = context(identity);
    const presentationB = { ...presentation, sourceIdentity: identity };
    const transportB = registry.get(sourceB.value, presentationB, 'codex-cli')!;
    vi.mocked(window.api.askRemoteHostPlanReview).mockResolvedValue({ accepted: true, revision: 9 });
    await expect(transportB.ask('source-b-question')).resolves.toBeUndefined();
  });

  it('retires failed intents only after their source identity is no longer addressable', async () => {
    const registry = new RemotePlanReviewTransports();
    const sourceA = context();
    const transportA = registry.get(sourceA.value, presentation, 'codex-cli')!;
    vi.mocked(window.api.askRemoteHostPlanReview).mockRejectedValue(new Error('offline'));
    for (let index = 0; index < 64; index += 1) {
      await expect(transportA.ask(`question-${index}`)).rejects.toThrow('offline');
    }
    await expect(transportA.ask('overflow')).rejects.toThrow('待确认的远程操作过多');

    registry.retainSources(new Set(['profile-b:core-b:1']));

    await expect(transportA.ask('after-retirement')).rejects.toThrow('offline');
  });
});
