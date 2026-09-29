import { describe, expect, it } from 'vitest';

import { beginGrokTurn, clearGrokTurnLiveRate, createGrokTranslationState, markGrokStandardUsageEmitted, translateGrokTurnUsage, translateGrokUsage, waitForGrokStandardUsage } from '../translate';

describe('Grok ACP event translation', () => {
  it('keeps an explicitly old contradictory correction out of the active grace window', async () => {
    const state = createGrokTranslationState();
    beginGrokTurn(state, 'app-session', 'grok-4.5', 'turn-corrected-prior');
    const priorStandard = translateGrokUsage(
      'app-session',
      'grok-4.5',
      { totalTokens: 15, inputTokens: 10, outputTokens: 5 },
      state,
    )!;
    priorStandard.ts = 1_000;
    markGrokStandardUsageEmitted(state, priorStandard);
    clearGrokTurnLiveRate(state);

    beginGrokTurn(state, 'app-session', 'grok-4.5', 'turn-after-correction');
    state.currentTurnStartedAt = 2_000;
    const currentStandard = translateGrokUsage(
      'app-session',
      'grok-4.5',
      { totalTokens: 25, inputTokens: 17, outputTokens: 8 },
      state,
    )!;
    const currentFallback = waitForGrokStandardUsage(state, 1_000);
    const priorCorrection = translateGrokTurnUsage(
      'app-session',
      'grok-4.5',
      {
        _meta: { agentTimestampMs: 1_001 },
        update: {
          sessionUpdate: 'turn_completed',
          prompt_id: 'prompt-corrected-prior',
          usage: { totalTokens: 16, inputTokens: 10, outputTokens: 6 },
        },
      },
      state,
    );

    expect(priorCorrection?.payload).toMatchObject({
      messageId: 'prompt-corrected-prior',
      outputTokens: 6,
      grokAffectsCurrentTurn: false,
    });
    expect(
      priorCorrection?.payload as {
        replacesMessageId?: string;
        grokUsageWatermark?: unknown;
      },
    ).not.toHaveProperty('replacesMessageId');
    expect(
      priorCorrection?.payload as { grokUsageWatermark?: unknown },
    ).not.toHaveProperty('grokUsageWatermark');
    expect(state.pendingStandardUsage).not.toBeNull();
    expect(state.extensionUsageForCurrentTurn).toBe(false);
    expect(state.lastUsage).toMatchObject({ inputTokens: 17, outputTokens: 8 });
    expect(currentStandard.payload).toMatchObject({
      inputTokens: 7,
      outputTokens: 3,
    });

    const currentExtension = translateGrokTurnUsage(
      'app-session',
      'grok-4.5',
      {
        update: {
          sessionUpdate: 'turn_completed',
          prompt_id: 'prompt-after-correction',
          usage: { totalTokens: 10, inputTokens: 7, outputTokens: 3 },
        },
      },
      state,
    );
    expect(currentExtension?.payload).toMatchObject({
      messageId: 'prompt-after-correction',
      inputTokens: 7,
      outputTokens: 3,
    });
    await expect(currentFallback).resolves.toBe(false);
  });

  it('advances a completed prompt optional metric before the next standard snapshot', () => {
    const state = createGrokTranslationState();
    beginGrokTurn(state, 'app-session', 'grok-4.5', 'turn-progressive-prior');
    translateGrokTurnUsage(
      'app-session',
      'grok-4.5',
      {
        update: {
          sessionUpdate: 'turn_completed',
          prompt_id: 'prompt-progressive-prior',
          usage: { inputTokens: 10, outputTokens: 5 },
        },
      },
      state,
    );
    clearGrokTurnLiveRate(state);

    beginGrokTurn(state, 'app-session', 'grok-4.5', 'turn-progressive-next');
    const correction = translateGrokTurnUsage(
      'app-session',
      'grok-4.5',
      {
        update: {
          sessionUpdate: 'turn_completed',
          prompt_id: 'prompt-progressive-prior',
          usage: { cachedWriteTokens: 2 },
        },
      },
      state,
    );
    expect(correction?.payload).toMatchObject({
      messageId: 'prompt-progressive-prior',
      cacheCreationTokens: 2,
      grokAffectsCurrentTurn: false,
      grokUsageWatermark: { cachedWriteTokens: 2 },
    });
    expect(state.turnStartUsage).toMatchObject({ cachedWriteTokens: 2 });
    expect(state.lastUsage).toMatchObject({ cachedWriteTokens: 2 });

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
      inputTokens: 7,
      outputTokens: 3,
      cacheCreationTokens: 1,
    });
  });

  it('recomputes an in-grace standard delta after a completed optional correction', async () => {
    const state = createGrokTranslationState();
    beginGrokTurn(state, 'app-session', 'grok-4.5', 'turn-grace-progressive-prior');
    translateGrokTurnUsage(
      'app-session',
      'grok-4.5',
      {
        update: {
          sessionUpdate: 'turn_completed',
          prompt_id: 'prompt-grace-progressive-prior',
          usage: { inputTokens: 10, outputTokens: 5 },
        },
      },
      state,
    );
    clearGrokTurnLiveRate(state);

    beginGrokTurn(state, 'app-session', 'grok-4.5', 'turn-grace-progressive-next');
    const currentStandard = translateGrokUsage(
      'app-session',
      'grok-4.5',
      {
        totalTokens: 25,
        inputTokens: 17,
        outputTokens: 8,
        cachedWriteTokens: 3,
      },
      state,
    )!;
    const currentFallback = waitForGrokStandardUsage(state, 1_000);
    expect(currentStandard.payload).toMatchObject({
      cacheCreationTokens: null,
    });

    const correction = translateGrokTurnUsage(
      'app-session',
      'grok-4.5',
      {
        update: {
          sessionUpdate: 'turn_completed',
          prompt_id: 'prompt-grace-progressive-prior',
          usage: { cachedWriteTokens: 2 },
        },
      },
      state,
    );
    expect(correction?.payload).toMatchObject({
      cacheCreationTokens: 2,
      grokAffectsCurrentTurn: false,
      // Only the corrected completed frontier is durable at this point.
      grokUsageWatermark: { cachedWriteTokens: 2 },
    });
    expect(state.pendingStandardUsage).not.toBeNull();
    // The same object retained by the turn queue is mutated before it can be emitted.
    expect(currentStandard.payload).toMatchObject({
      inputTokens: 7,
      outputTokens: 3,
      cacheCreationTokens: 1,
      grokUsageWatermark: { cachedWriteTokens: 3 },
    });

    const currentExtension = translateGrokTurnUsage(
      'app-session',
      'grok-4.5',
      {
        update: {
          sessionUpdate: 'turn_completed',
          prompt_id: 'prompt-grace-progressive-next',
          usage: { inputTokens: 7, outputTokens: 3, cachedWriteTokens: 1 },
        },
      },
      state,
    );
    expect(currentExtension?.payload).toMatchObject({
      messageId: 'prompt-grace-progressive-next',
      cacheCreationTokens: 1,
      grokUsageWatermark: { cachedWriteTokens: 3 },
    });
    await expect(currentFallback).resolves.toBe(false);
  });

  it('does not add a current extension metric already covered by an unknown-baseline snapshot', async () => {
    const state = createGrokTranslationState({
      lastUsage: {
        totalTokens: 15,
        inputTokens: 10,
        outputTokens: 5,
        thoughtTokens: null,
        cachedReadTokens: null,
        cachedWriteTokens: null,
      },
    });
    beginGrokTurn(state, 'app-session', 'grok-4.5', 'turn-covered-grace');
    const standard = translateGrokUsage(
      'app-session',
      'grok-4.5',
      {
        totalTokens: 25,
        inputTokens: 17,
        outputTokens: 8,
        cachedWriteTokens: 3,
      },
      state,
    )!;
    expect(standard.payload).toMatchObject({ cacheCreationTokens: null });
    const fallback = waitForGrokStandardUsage(state, 1_000);

    const extension = translateGrokTurnUsage(
      'app-session',
      'grok-4.5',
      {
        update: {
          sessionUpdate: 'turn_completed',
          prompt_id: 'prompt-covered-grace',
          usage: { cachedWriteTokens: 1 },
        },
      },
      state,
    );
    expect(extension?.payload).toMatchObject({
      cacheCreationTokens: 1,
      grokUsageWatermark: { cachedWriteTokens: 3 },
    });
    expect(state.lastUsage).toMatchObject({ cachedWriteTokens: 3 });

    expect(
      translateGrokTurnUsage(
        'app-session',
        'grok-4.5',
        {
          update: {
            sessionUpdate: 'turn_completed',
            prompt_id: 'prompt-covered-grace',
            usage: { cachedWriteTokens: 2 },
          },
        },
        state,
      )?.payload,
    ).toMatchObject({
      cacheCreationTokens: 2,
      grokUsageWatermark: { cachedWriteTokens: 3 },
    });
    expect(state.lastUsage).toMatchObject({ cachedWriteTokens: 3 });
    await expect(fallback).resolves.toBe(false);
    clearGrokTurnLiveRate(state);

    const completedProgressive = translateGrokTurnUsage(
      'app-session',
      'grok-4.5',
      {
        update: {
          sessionUpdate: 'turn_completed',
          prompt_id: 'prompt-covered-grace',
          usage: { cachedWriteTokens: 3 },
        },
      },
      state,
    );
    expect(completedProgressive?.payload).toMatchObject({
      cacheCreationTokens: 3,
      grokAffectsCurrentTurn: false,
    });
    expect(
      completedProgressive?.payload as Record<string, unknown>,
    ).not.toHaveProperty('grokUsageWatermark');
    expect(state.lastUsage).toMatchObject({ cachedWriteTokens: 3 });

    beginGrokTurn(state, 'app-session', 'grok-4.5', 'turn-after-covered-grace');
    expect(
      translateGrokUsage(
        'app-session',
        'grok-4.5',
        {
          totalTokens: 30,
          inputTokens: 20,
          outputTokens: 10,
          cachedWriteTokens: 4,
        },
        state,
      )?.payload,
    ).toMatchObject({
      totalTokens: 5,
      inputTokens: 3,
      outputTokens: 2,
      cacheCreationTokens: 1,
    });
  });

  it('does not add a post-grace extension metric already covered by an unknown-baseline snapshot', async () => {
    const state = createGrokTranslationState({
      lastUsage: {
        totalTokens: 15,
        inputTokens: 10,
        outputTokens: 5,
        thoughtTokens: null,
        cachedReadTokens: null,
        cachedWriteTokens: null,
      },
    });
    beginGrokTurn(state, 'app-session', 'grok-4.5', 'turn-covered-late');
    const standard = translateGrokUsage(
      'app-session',
      'grok-4.5',
      {
        totalTokens: 25,
        inputTokens: 17,
        outputTokens: 8,
        cachedWriteTokens: 3,
      },
      state,
    )!;
    await expect(waitForGrokStandardUsage(state, 0)).resolves.toBe(true);
    markGrokStandardUsageEmitted(state, standard);
    clearGrokTurnLiveRate(state);

    const late = translateGrokTurnUsage(
      'app-session',
      'grok-4.5',
      {
        update: {
          sessionUpdate: 'turn_completed',
          prompt_id: 'prompt-covered-late',
          usage: { cachedWriteTokens: 1 },
        },
      },
      state,
    );
    expect(late?.payload).toMatchObject({
      replacesMessageId: 'grok-standard:app-session:turn-covered-late',
      cacheCreationTokens: 1,
      grokAffectsCurrentTurn: false,
    });
    expect(late?.payload as Record<string, unknown>).not.toHaveProperty(
      'grokUsageWatermark',
    );
    expect(state.lastUsage).toMatchObject({ cachedWriteTokens: 3 });

    const progressive = translateGrokTurnUsage(
      'app-session',
      'grok-4.5',
      {
        update: {
          sessionUpdate: 'turn_completed',
          prompt_id: 'prompt-covered-late',
          usage: { cachedWriteTokens: 2 },
        },
      },
      state,
    );
    expect(progressive?.payload).toMatchObject({
      cacheCreationTokens: 2,
      grokAffectsCurrentTurn: false,
    });
    expect(progressive?.payload as Record<string, unknown>).not.toHaveProperty(
      'grokUsageWatermark',
    );
    expect(state.lastUsage).toMatchObject({ cachedWriteTokens: 3 });

    beginGrokTurn(state, 'app-session', 'grok-4.5', 'turn-after-covered-late');
    expect(
      translateGrokUsage(
        'app-session',
        'grok-4.5',
        {
          totalTokens: 30,
          inputTokens: 20,
          outputTokens: 10,
          cachedWriteTokens: 4,
        },
        state,
      )?.payload,
    ).toMatchObject({ cacheCreationTokens: 1 });
  });

  it('leaves ambiguous optional-only live fallbacks separate', () => {
    const state = createGrokTranslationState();
    beginGrokTurn(state, 'app-session', 'grok-4.5', 'turn-ambiguous-one');
    const first = translateGrokUsage(
      'app-session',
      'grok-4.5',
      { totalTokens: 15, inputTokens: 10, outputTokens: 5 },
      state,
    )!;
    first.ts = 1_000;
    markGrokStandardUsageEmitted(state, first);
    clearGrokTurnLiveRate(state);

    beginGrokTurn(state, 'app-session', 'grok-4.5', 'turn-ambiguous-two');
    const second = translateGrokUsage(
      'app-session',
      'grok-4.5',
      { totalTokens: 25, inputTokens: 17, outputTokens: 8 },
      state,
    )!;
    second.ts = 1_010;
    markGrokStandardUsageEmitted(state, second);
    clearGrokTurnLiveRate(state);

    const optional = translateGrokTurnUsage(
      'app-session',
      'grok-4.5',
      {
        _meta: { agentTimestampMs: 1_005 },
        update: {
          sessionUpdate: 'turn_completed',
          prompt_id: 'prompt-ambiguous-optional',
          usage: { cachedWriteTokens: 2 },
        },
      },
      state,
    );
    expect(optional?.payload).toMatchObject({
      messageId: 'prompt-ambiguous-optional',
      cacheCreationTokens: 2,
      grokAffectsCurrentTurn: false,
    });
    expect(
      optional?.payload as { replacesMessageId?: string },
    ).not.toHaveProperty('replacesMessageId');
    expect(state.uncorrelatedStandardUsage).toHaveLength(2);
    expect(state.extensionUsageForCurrentTurn).toBe(false);
  });
});
