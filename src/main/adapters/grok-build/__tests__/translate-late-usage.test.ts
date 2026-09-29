import { describe, expect, it } from 'vitest';

import { beginGrokTurn, clearGrokTurnLiveRate, createGrokTranslationState, markGrokStandardUsageEmitted, translateGrokTurnUsage, translateGrokUpdate, translateGrokUsage, waitForGrokStandardUsage } from '../translate';

describe('Grok ACP event translation', () => {
  it('falls back to extension metadata for prompt id and timestamp', () => {
    const state = createGrokTranslationState();
    beginGrokTurn(state, 'app-session', null, 'turn-meta');
    const event = translateGrokTurnUsage(
      'app-session',
      null,
      {
        _meta: { promptId: 'meta-prompt', agentTimestampMs: 1_700_000_000_123 },
        update: {
          sessionUpdate: 'turn_completed',
          usage: { inputTokens: 1, outputTokens: 2 },
        },
      },
      state,
    );

    expect(event).toMatchObject({
      ts: 1_700_000_000_123,
      payload: { messageId: 'meta-prompt', inputTokens: 1, outputTokens: 2 },
    });
  });

  it('prefers a late extension usage event over a standard response usage event', async () => {
    const state = createGrokTranslationState();
    beginGrokTurn(state, 'app-session', 'grok-4.5', 'turn-grace');
    const standard = translateGrokUsage(
      'app-session',
      'grok-4.5',
      { totalTokens: 15, inputTokens: 10, outputTokens: 5, thoughtTokens: 1 },
      state,
    );
    expect(standard).not.toBeNull();

    const fallback = waitForGrokStandardUsage(state, 1_000);
    const extension = translateGrokTurnUsage(
      'app-session',
      'grok-4.5',
      {
        update: {
          sessionUpdate: 'turn_completed',
          prompt_id: 'prompt-late',
          usage: { inputTokens: 10, outputTokens: 5, reasoningTokens: 1 },
        },
      },
      state,
    );

    expect(extension?.payload).toMatchObject({ messageId: 'prompt-late', outputTokens: 5 });
    await expect(fallback).resolves.toBe(false);
  });

  it('falls back to standard usage when no Grok extension event arrives', async () => {
    const state = createGrokTranslationState();
    beginGrokTurn(state, 'app-session', 'grok-4.5', 'turn-fallback');
    const standard = translateGrokUsage(
      'app-session',
      'grok-4.5',
      { totalTokens: 15, inputTokens: 10, outputTokens: 5 },
      state,
    );
    expect(standard).not.toBeNull();

    await expect(waitForGrokStandardUsage(state, 0)).resolves.toBe(true);
    markGrokStandardUsageEmitted(state, standard!);
    const lateExtension = translateGrokTurnUsage(
      'app-session',
      'grok-4.5',
      {
        update: {
          sessionUpdate: 'turn_completed',
          prompt_id: 'prompt-too-late',
          usage: { inputTokens: 10, outputTokens: 5 },
        },
      },
      state,
    );
    expect(lateExtension?.payload).toMatchObject({
      messageId: 'prompt-too-late',
      replacesMessageId: 'grok-standard:app-session:turn-fallback',
      inputTokens: 10,
      outputTokens: 5,
      grokAffectsCurrentTurn: false,
    });
  });

  it('keeps a prior late extension from mutating the next active turn', () => {
    const state = createGrokTranslationState();
    beginGrokTurn(state, 'app-session', 'grok-4.5', 'turn-prior');
    const priorStandard = translateGrokUsage(
      'app-session',
      'grok-4.5',
      { totalTokens: 15, inputTokens: 10, outputTokens: 5 },
      state,
    )!;
    markGrokStandardUsageEmitted(state, priorStandard);
    clearGrokTurnLiveRate(state);

    beginGrokTurn(state, 'app-session', 'grok-4.5', 'turn-current');
    const latePrior = translateGrokTurnUsage(
      'app-session',
      'grok-4.5',
      {
        update: {
          sessionUpdate: 'turn_completed',
          prompt_id: 'prompt-prior',
          usage: { totalTokens: 15, inputTokens: 10, outputTokens: 5 },
        },
      },
      state,
    );

    expect(latePrior?.payload).toMatchObject({
      messageId: 'prompt-prior',
      replacesMessageId: 'grok-standard:app-session:turn-prior',
      grokAffectsCurrentTurn: false,
    });
    expect(state.extensionUsageForCurrentTurn).toBe(false);
    expect(state.usageSource).toBe('none');
    expect(state.currentTurnUsageId).toBe(
      'grok-standard:app-session:turn-current',
    );

    expect(
      translateGrokUsage(
        'app-session',
        'grok-4.5',
        { totalTokens: 25, inputTokens: 17, outputTokens: 8 },
        state,
      )?.payload,
    ).toMatchObject({
      messageId: 'grok-standard:app-session:turn-current',
      totalTokens: 10,
      inputTokens: 7,
      outputTokens: 3,
    });
  });

  it('does not cancel the current grace window when a prior extension arrives', async () => {
    const state = createGrokTranslationState();
    beginGrokTurn(state, 'app-session', 'grok-4.5', 'turn-prior-grace');
    const priorStandard = translateGrokUsage(
      'app-session',
      'grok-4.5',
      { totalTokens: 15, inputTokens: 10, outputTokens: 5 },
      state,
    )!;
    markGrokStandardUsageEmitted(state, priorStandard);
    clearGrokTurnLiveRate(state);

    beginGrokTurn(state, 'app-session', 'grok-4.5', 'turn-current-grace');
    translateGrokUsage(
      'app-session',
      'grok-4.5',
      { totalTokens: 25, inputTokens: 17, outputTokens: 8 },
      state,
    );
    const currentFallback = waitForGrokStandardUsage(state, 1_000);
    const latePrior = translateGrokTurnUsage(
      'app-session',
      'grok-4.5',
      {
        update: {
          sessionUpdate: 'turn_completed',
          prompt_id: 'prompt-prior-grace',
          usage: { totalTokens: 15, inputTokens: 10, outputTokens: 5 },
        },
      },
      state,
    );
    expect(latePrior?.payload).toMatchObject({
      grokAffectsCurrentTurn: false,
      replacesMessageId: 'grok-standard:app-session:turn-prior-grace',
    });
    expect(
      (latePrior?.payload as { grokUsageWatermark?: unknown })
        .grokUsageWatermark,
    ).toBeUndefined();
    expect(state.pendingStandardUsage).not.toBeNull();
    expect(state.extensionUsageForCurrentTurn).toBe(false);

    const currentExtension = translateGrokTurnUsage(
      'app-session',
      'grok-4.5',
      {
        update: {
          sessionUpdate: 'turn_completed',
          prompt_id: 'prompt-current-grace',
          usage: { totalTokens: 10, inputTokens: 7, outputTokens: 3 },
        },
      },
      state,
    );
    expect(currentExtension?.payload).toMatchObject({
      messageId: 'prompt-current-grace',
      totalTokens: 10,
      inputTokens: 7,
      outputTokens: 3,
    });
    expect(
      (currentExtension?.payload as { grokAffectsCurrentTurn?: boolean })
        .grokAffectsCurrentTurn,
    ).toBeUndefined();
    await expect(currentFallback).resolves.toBe(false);
  });

  it('uses an ACP user message id only as an exact current-turn hint', () => {
    const state = createGrokTranslationState();
    beginGrokTurn(state, 'app-session', 'grok-4.5', 'turn-hint-prior');
    const priorStandard = translateGrokUsage(
      'app-session',
      'grok-4.5',
      { totalTokens: 15, inputTokens: 10, outputTokens: 5 },
      state,
    )!;
    markGrokStandardUsageEmitted(state, priorStandard);
    clearGrokTurnLiveRate(state);

    beginGrokTurn(state, 'app-session', 'grok-4.5', 'turn-hint-current');
    translateGrokUpdate(
      'app-session',
      '/repo',
      {
        sessionUpdate: 'user_message_chunk',
        messageId: 'prompt-current-hint',
        content: { type: 'text', text: 'current prompt' },
      },
      state,
    );
    const current = translateGrokTurnUsage(
      'app-session',
      'grok-4.5',
      {
        update: {
          sessionUpdate: 'turn_completed',
          prompt_id: 'prompt-current-hint',
          usage: { totalTokens: 15, inputTokens: 10, outputTokens: 5 },
        },
      },
      state,
    );

    expect(state.currentProviderPromptId).toBe('prompt-current-hint');
    expect(current?.payload).toMatchObject({
      messageId: 'prompt-current-hint',
    });
    expect(
      (current?.payload as {
        replacesMessageId?: string;
        grokAffectsCurrentTurn?: boolean;
      }).replacesMessageId,
    ).toBeUndefined();
    expect(state.uncorrelatedStandardUsage).toHaveLength(1);
    expect(state.extensionUsageForCurrentTurn).toBe(true);
  });

  it('does not let a stale same-shaped fallback steal the active turn extension', () => {
    const state = createGrokTranslationState();
    beginGrokTurn(state, 'app-session', 'grok-4.5', 'turn-stale-prior');
    const priorStandard = translateGrokUsage(
      'app-session',
      'grok-4.5',
      { totalTokens: 15, inputTokens: 10, outputTokens: 5 },
      state,
    )!;
    priorStandard.ts = Date.now() - 31_000;
    markGrokStandardUsageEmitted(state, priorStandard);
    clearGrokTurnLiveRate(state);
    beginGrokTurn(state, 'app-session', 'grok-4.5', 'turn-after-stale');

    const current = translateGrokTurnUsage(
      'app-session',
      'grok-4.5',
      {
        update: {
          sessionUpdate: 'turn_completed',
          prompt_id: 'prompt-after-stale',
          usage: { totalTokens: 15, inputTokens: 10, outputTokens: 5 },
        },
      },
      state,
    );

    expect(
      (current?.payload as {
        replacesMessageId?: string;
        grokAffectsCurrentTurn?: boolean;
      }).replacesMessageId,
    ).toBeUndefined();
    expect(state.uncorrelatedStandardUsage).toHaveLength(1);
    expect(state.extensionUsageForCurrentTurn).toBe(true);
  });

  it('reconciles an optional-only prior extension without stealing the current turn', () => {
    const state = createGrokTranslationState();
    beginGrokTurn(state, 'app-session', 'grok-4.5', 'turn-optional-prior');
    const priorStandard = translateGrokUsage(
      'app-session',
      'grok-4.5',
      { totalTokens: 15, inputTokens: 10, outputTokens: 5 },
      state,
    )!;
    priorStandard.ts = 1_000;
    markGrokStandardUsageEmitted(state, priorStandard);
    clearGrokTurnLiveRate(state);
    beginGrokTurn(state, 'app-session', 'grok-4.5', 'turn-optional-current');

    const latePrior = translateGrokTurnUsage(
      'app-session',
      'grok-4.5',
      {
        _meta: { agentTimestampMs: 1_001 },
        update: {
          sessionUpdate: 'turn_completed',
          prompt_id: 'prompt-optional-prior',
          usage: { cachedWriteTokens: 2 },
        },
      },
      state,
    );

    expect(latePrior?.payload).toMatchObject({
      messageId: 'prompt-optional-prior',
      replacesMessageId: 'grok-standard:app-session:turn-optional-prior',
      inputTokens: 10,
      outputTokens: 5,
      cacheCreationTokens: 2,
      grokAffectsCurrentTurn: false,
    });
    expect(state.extensionUsageForCurrentTurn).toBe(false);
    expect(state.currentTurnUsageId).toBe(
      'grok-standard:app-session:turn-optional-current',
    );
    expect(latePrior?.payload).toMatchObject({
      grokUsageWatermark: { cachedWriteTokens: 2 },
    });
    expect(
      translateGrokUsage(
        'app-session',
        'grok-4.5',
        {
          totalTokens: 25,
          inputTokens: 17,
          outputTokens: 8,
          cachedWriteTokens: 3,
        },
        state,
      )?.payload,
    ).toMatchObject({
      totalTokens: 10,
      inputTokens: 7,
      outputTokens: 3,
      cacheCreationTokens: 1,
    });
  });
});
