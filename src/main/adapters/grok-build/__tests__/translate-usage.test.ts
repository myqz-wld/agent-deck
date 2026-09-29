import { describe, expect, it } from 'vitest';

import { beginGrokTurn, clearGrokTurnLiveRate, createGrokTranslationState, translateGrokTurnUsage, translateGrokUsage, waitForGrokStandardUsage } from '../translate';

describe('Grok ACP event translation', () => {
  it('emits cumulative usage as non-negative deltas', () => {
    const state = createGrokTranslationState();
    beginGrokTurn(state, 'app-session', 'grok-4.5', 'turn-1');
    const first = translateGrokUsage(
      'app-session',
      'grok-4.5',
      { totalTokens: 15, inputTokens: 10, outputTokens: 5, thoughtTokens: 2 },
      state,
    );
    beginGrokTurn(state, 'app-session', 'grok-4.5', 'turn-2');
    const second = translateGrokUsage(
      'app-session',
      'grok-4.5',
      { totalTokens: 23, inputTokens: 15, outputTokens: 8, thoughtTokens: 4 },
      state,
    );
    expect(first?.payload).toMatchObject({
      totalTokens: 15,
      inputTokens: 10,
      outputTokens: 5,
      reasoningTokens: 2,
    });
    expect(second?.payload).toMatchObject({
      totalTokens: 8,
      inputTokens: 5,
      outputTokens: 3,
      reasoningTokens: 2,
    });
  });

  it('advances a fresh first-turn cumulative frontier by only the extension correction', async () => {
    const state = createGrokTranslationState();
    beginGrokTurn(state, 'app-session', 'grok-4.5', 'turn-fresh');
    translateGrokUsage(
      'app-session',
      'grok-4.5',
      { totalTokens: 15, inputTokens: 10, outputTokens: 5 },
      state,
    )!;
    const fallback = waitForGrokStandardUsage(state, 1_000);

    expect(
      translateGrokTurnUsage(
        'app-session',
        'grok-4.5',
        {
          update: {
            sessionUpdate: 'turn_completed',
            prompt_id: 'prompt-fresh',
            usage: { totalTokens: 16, inputTokens: 11, outputTokens: 5 },
          },
        },
        state,
      )?.payload,
    ).toMatchObject({
      messageId: 'prompt-fresh',
      totalTokens: 16,
      inputTokens: 11,
      outputTokens: 5,
      grokUsageWatermark: {
        totalTokens: 16,
        inputTokens: 11,
        outputTokens: 5,
      },
    });
    expect(state.lastUsage).toMatchObject({
      totalTokens: 16,
      inputTokens: 11,
      outputTokens: 5,
    });
    await expect(fallback).resolves.toBe(false);
    clearGrokTurnLiveRate(state);

    beginGrokTurn(state, 'app-session', 'grok-4.5', 'turn-after-fresh');
    expect(
      translateGrokUsage(
        'app-session',
        'grok-4.5',
        { totalTokens: 20, inputTokens: 15, outputTokens: 5 },
        state,
      )?.payload,
    ).toMatchObject({
      totalTokens: 4,
      inputTokens: 4,
      outputTokens: 0,
    });
  });

  it('advances uncovered back-to-back current corrections before grace cleanup', async () => {
    const state = createGrokTranslationState();
    beginGrokTurn(state, 'app-session', 'grok-4.5', 'turn-fresh-progressive');
    translateGrokUsage(
      'app-session',
      'grok-4.5',
      { totalTokens: 15, inputTokens: 10, outputTokens: 5 },
      state,
    );
    const fallback = waitForGrokStandardUsage(state, 1_000);

    translateGrokTurnUsage(
      'app-session',
      'grok-4.5',
      {
        update: {
          sessionUpdate: 'turn_completed',
          prompt_id: 'prompt-fresh-progressive',
          usage: { totalTokens: 16, inputTokens: 11, outputTokens: 5 },
        },
      },
      state,
    );
    expect(
      translateGrokTurnUsage(
        'app-session',
        'grok-4.5',
        {
          update: {
            sessionUpdate: 'turn_completed',
            prompt_id: 'prompt-fresh-progressive',
            usage: { totalTokens: 17, inputTokens: 12, outputTokens: 5 },
          },
        },
        state,
      )?.payload,
    ).toMatchObject({
      totalTokens: 17,
      inputTokens: 12,
      outputTokens: 5,
      grokUsageWatermark: {
        totalTokens: 17,
        inputTokens: 12,
        outputTokens: 5,
      },
    });
    expect(state.lastUsage).toMatchObject({
      totalTokens: 17,
      inputTokens: 12,
      outputTokens: 5,
    });
    await expect(fallback).resolves.toBe(false);
    clearGrokTurnLiveRate(state);

    beginGrokTurn(state, 'app-session', 'grok-4.5', 'turn-after-progressive');
    expect(
      translateGrokUsage(
        'app-session',
        'grok-4.5',
        { totalTokens: 20, inputTokens: 15, outputTokens: 5 },
        state,
      )?.payload,
    ).toMatchObject({
      totalTokens: 3,
      inputTokens: 3,
      outputTokens: 0,
    });
  });

  it('continues cumulative deltas from a persisted recovery watermark', () => {
    const state = createGrokTranslationState({
      lastUsage: {
        totalTokens: 100,
        inputTokens: 80,
        outputTokens: 20,
        thoughtTokens: null,
        cachedReadTokens: 10,
        cachedWriteTokens: null,
      },
    });

    beginGrokTurn(state, 'app-session', 'grok-4.5', 'recovered-turn');
    expect(
      translateGrokUsage(
        'app-session',
        'grok-4.5',
        {
          totalTokens: 112,
          inputTokens: 88,
          outputTokens: 24,
          thoughtTokens: 3,
          cachedReadTokens: 12,
        },
        state,
      )?.payload,
    ).toMatchObject({
      totalTokens: 12,
      inputTokens: 8,
      outputTokens: 4,
      reasoningTokens: null,
      cacheReadTokens: 2,
      cacheCreationTokens: null,
    });
  });

  it('maps Grok turn usage directly, deduplicates prompt_id, and keeps turns independent', () => {
    const state = createGrokTranslationState();
    beginGrokTurn(state, 'app-session', null, 'turn-1');
    const first = translateGrokTurnUsage(
      'app-session',
      null,
      {
        timestamp: 1_700_000_000,
        update: {
          sessionUpdate: 'turn_completed',
          prompt_id: 'prompt-1',
          usage: {
            inputTokens: 621250,
            outputTokens: 2368,
            totalTokens: 623618,
            cachedReadTokens: 287833,
            cachedWriteTokens: 811,
            reasoningTokens: 4,
            modelUsage: { 'claude-fable-5': {} },
          },
        },
      },
      state,
    );
    const duplicate = translateGrokTurnUsage(
      'app-session',
      null,
      {
        update: {
          sessionUpdate: 'turn_completed',
          prompt_id: 'prompt-1',
          usage: { inputTokens: 999, outputTokens: 999 },
        },
      },
      state,
    );
    beginGrokTurn(state, 'app-session', 'grok-4.5', 'turn-2');
    const second = translateGrokTurnUsage(
      'app-session',
      'grok-4.5',
      {
        update: {
          sessionUpdate: 'turn_completed',
          prompt_id: 'prompt-2',
          usage: { inputTokens: 10, outputTokens: 7, cachedReadTokens: 2 },
        },
      },
      state,
    );
    expect(first?.payload).toMatchObject({
      messageId: 'prompt-1',
      model: 'claude-fable-5',
      inputTokens: 621250,
      outputTokens: 2368,
      reasoningTokens: 4,
      cacheReadTokens: 287833,
      cacheCreationTokens: 811,
    });
    expect(duplicate).toBeNull();
    expect(second?.payload).toMatchObject({
      messageId: 'prompt-2',
      model: 'grok-4.5',
      totalTokens: null,
      inputTokens: 10,
      outputTokens: 7,
      reasoningTokens: null,
      cacheReadTokens: 2,
      cacheCreationTokens: null,
    });
  });

  it('persists total-only extension usage and lets standard ACP complete the same row', () => {
    const state = createGrokTranslationState();
    beginGrokTurn(state, 'app-session', 'grok-4.5', 'turn-total-only');
    const extension = translateGrokTurnUsage(
      'app-session',
      'grok-4.5',
      {
        update: {
          sessionUpdate: 'turn_completed',
          prompt_id: 'prompt-total-only',
          usage: { totalTokens: 14 },
        },
      },
      state,
    );
    expect(extension?.payload).toMatchObject({
      messageId: 'prompt-total-only',
      totalTokens: 14,
      inputTokens: null,
      outputTokens: null,
    });
    expect(state.usageSource).toBe('extension');
    expect(state.extensionUsageForCurrentTurn).toBe(true);

    expect(
      translateGrokUsage(
        'app-session',
        'grok-4.5',
        { totalTokens: 14, inputTokens: 10, outputTokens: 4 },
        state,
      )?.payload,
    ).toMatchObject({
      messageId: 'prompt-total-only',
      totalTokens: 14,
      inputTokens: 10,
      outputTokens: 4,
    });
  });

  it('preserves missing optional extension metrics as unknown', () => {
    const state = createGrokTranslationState();
    beginGrokTurn(state, 'app-session', 'grok-4.5', 'turn-partial');
    expect(
      translateGrokTurnUsage(
        'app-session',
        'grok-4.5',
        {
          update: {
            sessionUpdate: 'turn_completed',
            prompt_id: 'prompt-partial',
            usage: { inputTokens: 10, outputTokens: 4 },
          },
        },
        state,
      )?.payload,
    ).toMatchObject({
      totalTokens: null,
      inputTokens: 10,
      outputTokens: 4,
      reasoningTokens: null,
      cacheReadTokens: null,
      cacheCreationTokens: null,
    });
  });

  it('carries extension usage into the cumulative standard usage baseline', () => {
    const state = createGrokTranslationState();
    beginGrokTurn(state, 'app-session', 'grok-4.5', 'turn-extension');
    expect(
      translateGrokTurnUsage(
        'app-session',
        'grok-4.5',
        {
          update: {
            sessionUpdate: 'turn_completed',
            prompt_id: 'prompt-extension',
            usage: { inputTokens: 10, outputTokens: 4, totalTokens: 14 },
          },
        },
        state,
      ),
    ).not.toBeNull();

    beginGrokTurn(state, 'app-session', 'grok-4.5');
    const standard = translateGrokUsage(
      'app-session',
      'grok-4.5',
      { totalTokens: 21, inputTokens: 15, outputTokens: 6 },
      state,
    );

    expect(standard?.payload).toMatchObject({ inputTokens: 5, outputTokens: 2 });
  });
});
