import { describe, expect, it } from 'vitest';

import {
  beginGrokTurn,
  clearGrokTurnLiveRate,
  createGrokTranslationState,
  flushGrokTextUpdates,
  markGrokStandardUsageEmitted,
  translateGrokTurnUsage,
  translateGrokUpdate,
  translateGrokUsage,
  waitForGrokStandardUsage,
} from '../translate';

describe('Grok ACP event translation', () => {
  it('maps ACP current-context usage without treating it as cumulative token usage', () => {
    const [event] = translateGrokUpdate(
      'app-session',
      '/repo',
      { sessionUpdate: 'usage_update', used: 65_432, size: 131_072 },
      createGrokTranslationState(),
    );

    expect(event).toMatchObject({
      kind: 'context-usage',
      payload: { usedTokens: 65_432, windowTokens: 131_072 },
    });
  });

  it('maps text, thought, tool, diff, and plan updates', () => {
    const state = createGrokTranslationState();
    expect(translateGrokUpdate(
      'app-session',
      '/repo',
      {
        sessionUpdate: 'agent_message_chunk',
        content: { type: 'text', text: 'hel' },
      },
      state,
    )).toEqual([]);
    expect(translateGrokUpdate(
      'app-session',
      '/repo',
      {
        sessionUpdate: 'agent_message_chunk',
        content: { type: 'text', text: 'lo' },
      },
      state,
    )).toEqual([]);
    expect(
      translateGrokUpdate(
        'app-session',
        '/repo',
        {
          sessionUpdate: 'agent_thought_chunk',
          content: { type: 'text', text: 'reasoning' },
        },
        state,
      )[0],
    ).toMatchObject({ kind: 'message', payload: { text: 'hello' } });

    const started = translateGrokUpdate(
      'app-session',
      '/repo',
      {
        sessionUpdate: 'tool_call',
        toolCallId: 'tool-1',
        title: 'Edit',
        kind: 'edit',
        status: 'in_progress',
      },
      state,
    );
    expect(started.map((event) => event.kind)).toEqual([
      'thinking',
      'tool-use-start',
    ]);
    expect(started[1]?.payload).toMatchObject({ toolKind: 'edit' });
    const completed = translateGrokUpdate(
      'app-session',
      '/repo',
      {
        sessionUpdate: 'tool_call_update',
        toolCallId: 'tool-1',
        status: 'completed',
        content: [
          {
            type: 'diff',
            path: 'src/a.ts',
            oldText: 'old',
            newText: 'new',
          },
        ],
      },
      state,
    );
    expect(completed.map((event) => event.kind)).toEqual([
      'tool-use-end',
      'file-changed',
    ]);
    expect(completed[0]?.payload).toMatchObject({
      toolName: 'Edit',
      status: 'completed',
    });
  });

  it('keeps one stable tool name when ACP updates the human-readable title', () => {
    const state = createGrokTranslationState();
    const [started] = translateGrokUpdate(
      'app-session',
      '/repo',
      {
        sessionUpdate: 'tool_call',
        toolCallId: 'tool-title-patch',
        title: 'run_terminal_command',
        kind: 'execute',
        status: 'in_progress',
        rawInput: { command: 'pnpm test' },
      },
      state,
    );
    const [completed] = translateGrokUpdate(
      'app-session',
      '/repo',
      {
        sessionUpdate: 'tool_call_update',
        toolCallId: 'tool-title-patch',
        title: 'Finished running pnpm test',
        status: 'completed',
        rawOutput: 'ok',
      },
      state,
    );

    expect(started).toMatchObject({
      kind: 'tool-use-start',
      payload: { toolName: 'run_terminal_command', status: 'inProgress' },
    });
    expect(completed).toMatchObject({
      kind: 'tool-use-end',
      payload: { toolName: 'run_terminal_command', status: 'completed' },
    });
  });

  it('prefers the ACP programmatic name and preserves canonical failed status', () => {
    const state = createGrokTranslationState();
    const [started] = translateGrokUpdate(
      'app-session',
      '/repo',
      {
        sessionUpdate: 'tool_call',
        toolCallId: 'tool-programmatic-name',
        name: 'search_tool',
        title: 'Searching the repository',
        kind: 'search',
        status: 'in_progress',
        rawInput: { pattern: 'toolName' },
      },
      state,
    );
    const [failed] = translateGrokUpdate(
      'app-session',
      '/repo',
      {
        sessionUpdate: 'tool_call_update',
        toolCallId: 'tool-programmatic-name',
        name: 'search_tool',
        title: 'Repository search failed',
        status: 'failed',
        rawOutput: 'search unavailable',
      },
      state,
    );

    expect(started).toMatchObject({
      kind: 'tool-use-start',
      payload: { toolName: 'search_tool', toolKind: 'search' },
    });
    expect(failed).toMatchObject({
      kind: 'tool-use-end',
      payload: { toolName: 'search_tool', toolKind: 'search', status: 'failed' },
    });
  });

  it('closes an ACP tool_call that arrives in a terminal state without waiting for an update', () => {
    const state = createGrokTranslationState();
    const events = translateGrokUpdate(
      'app-session',
      '/repo',
      {
        sessionUpdate: 'tool_call',
        toolCallId: 'tool-already-complete',
        name: 'fast_tool',
        title: 'Fast tool',
        kind: 'execute',
        status: 'completed',
        rawInput: { value: 1 },
        rawOutput: { ok: true },
      },
      state,
    );

    expect(events).toMatchObject([
      {
        kind: 'tool-use-start',
        payload: { toolUseId: 'tool-already-complete', status: 'completed' },
      },
      {
        kind: 'tool-use-end',
        payload: {
          toolUseId: 'tool-already-complete',
          status: 'completed',
          toolResult: { ok: true },
        },
      },
    ]);
    expect(state.startedToolIds.has('tool-already-complete')).toBe(false);
  });

  it('coalesces contiguous ACP chunks into one persisted bubble', () => {
    const state = createGrokTranslationState();
    for (const text of ['one', ' ', 'message']) {
      expect(translateGrokUpdate(
        'app-session',
        '/repo',
        {
          sessionUpdate: 'agent_message_chunk',
          content: { type: 'text', text },
        },
        state,
      )).toEqual([]);
    }
    expect(flushGrokTextUpdates('app-session', state)).toMatchObject([
      { kind: 'message', payload: { text: 'one message', role: 'assistant' } },
    ]);
    expect(flushGrokTextUpdates('app-session', state)).toEqual([]);
  });

  it('separates consecutive ACP messages by messageId', () => {
    const state = createGrokTranslationState();
    expect(
      translateGrokUpdate(
        'app-session',
        '/repo',
        {
          sessionUpdate: 'agent_message_chunk',
          messageId: 'message-1',
          content: { type: 'text', text: 'first' },
        },
        state,
      ),
    ).toEqual([]);
    expect(
      translateGrokUpdate(
        'app-session',
        '/repo',
        {
          sessionUpdate: 'agent_message_chunk',
          messageId: 'message-2',
          content: { type: 'text', text: 'second' },
        },
        state,
      ),
    ).toMatchObject([{ kind: 'message', payload: { text: 'first' } }]);
    expect(flushGrokTextUpdates('app-session', state)).toMatchObject([
      { kind: 'message', payload: { text: 'second' } },
    ]);
  });

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

  it('renders think tool calls as thinking events rather than tool cards', () => {
    const state = createGrokTranslationState();
    const started = translateGrokUpdate(
      'app-session',
      '/repo',
      {
        sessionUpdate: 'tool_call',
        toolCallId: 'think-1',
        title: 'think',
        kind: 'think',
        rawInput: { thought: 'checking the safest edit' },
      },
      state,
    );
    const completed = translateGrokUpdate(
      'app-session',
      '/repo',
      {
        sessionUpdate: 'tool_call_update',
        toolCallId: 'think-1',
        kind: 'think',
        status: 'completed',
      },
      state,
    );
    expect(started.map((event) => event.kind)).toEqual(['thinking']);
    expect(completed).toEqual([]);
  });

  it('does not persist returned image base64 in event payloads', () => {
    const state = createGrokTranslationState();
    const [event] = translateGrokUpdate(
      'app-session',
      '/repo',
      {
        sessionUpdate: 'agent_message_chunk',
        content: {
          type: 'image',
          data: 'aGVsbG8=',
          mimeType: 'image/png',
        },
      },
      state,
    );
    expect(JSON.stringify(event)).not.toContain('aGVsbG8=');
    expect(event).toMatchObject({
      kind: 'message',
      payload: { image: { mime: 'image/png', byteLength: 6 } },
    });
  });
});
