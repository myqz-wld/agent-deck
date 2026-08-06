import { describe, expect, it } from 'vitest';

import {
  emitClaudeAssistantUsage,
  reconcileClaudeFinalResultUsage,
} from './final-result-usage-core';
import { makeInternalSession } from './types';

function internal() {
  return makeInternalSession({
    cwd: '/workspace',
    permissionMode: 'default',
    applicationSid: 'application-a',
  });
}

function emitter() {
  const rows: Array<{ kind: string; payload: unknown }> = [];
  return {
    rows,
    emit: (kind: string, payload: unknown): void => {
      rows.push({ kind, payload });
    },
  };
}

describe('Claude final result usage Core', () => {
  it('deduplicates progressive assistant usage by message watermark', () => {
    const session = internal();
    const { rows, emit } = emitter();

    emitClaudeAssistantUsage(emit, 'fallback', {
      id: 'assistant-1',
      model: 'claude-opus-4-8',
      usage: { input_tokens: 100, output_tokens: 10 },
    }, session);
    emitClaudeAssistantUsage(emit, 'fallback', {
      id: 'assistant-1',
      model: 'claude-opus-4-8',
      usage: { input_tokens: 100, output_tokens: 15 },
    }, session);
    emitClaudeAssistantUsage(emit, 'fallback', {
      id: 'assistant-1',
      model: 'claude-opus-4-8',
      usage: { input_tokens: 99, output_tokens: 14 },
    }, session);
    emitClaudeAssistantUsage(emit, 'fallback', {
      usage: { input_tokens: 1, output_tokens: 1 },
    }, session);

    expect(rows).toHaveLength(2);
    expect([...session.turnUsageByBucket.values()]).toEqual([{
      input: 100,
      output: 15,
      reasoning: 0,
      cacheRead: 0,
      cacheCreation: 0,
    }]);
    expect(session.seenUsageMessageIds.get('assistant-1')).toMatchObject({
      input: 100,
      output: 15,
    });
  });

  it('reconciles one cumulative model once and advances its watermark', () => {
    const session = internal();
    const { rows, emit } = emitter();
    const result = {
      uuid: 'result-1',
      usage: {
        input_tokens: 100,
        output_tokens: 20,
        output_tokens_details: { thinking_tokens: 5 },
      },
      modelUsage: {
        'claude-opus-4-8': { inputTokens: 100, outputTokens: 20 },
      },
    };

    expect(reconcileClaudeFinalResultUsage(
      emit,
      'fallback',
      result,
      session,
    )).toEqual({ outputTokens: 20, liveRateModel: 'claude-opus-4-8' });
    expect(rows).toEqual([
      expect.objectContaining({
        kind: 'token-usage',
        payload: expect.objectContaining({
          messageId: 'result-delta-v2:result-1:model:claude-opus-4-8',
          outputTokens: 20,
          reasoningTokens: 5,
        }),
      }),
    ]);

    rows.length = 0;
    expect(reconcileClaudeFinalResultUsage(
      emit,
      'fallback',
      result,
      session,
    )).toEqual({ outputTokens: 0, liveRateModel: 'claude-opus-4-8' });
    expect(rows).toEqual([]);
  });

  it('uses the first resumed result only as a baseline before emitting growth', () => {
    const session = internal();
    session.claudeResultBaselinePending = true;
    const { rows, emit } = emitter();

    expect(reconcileClaudeFinalResultUsage(emit, 'fallback', {
      uuid: 'baseline',
      usage: { input_tokens: 40, output_tokens: 10 },
    }, session)).toEqual({ outputTokens: 0, liveRateModel: null });
    expect(rows).toEqual([]);
    expect(session.claudeResultBaselinePending).toBe(false);

    expect(reconcileClaudeFinalResultUsage(emit, 'fallback', {
      uuid: 'growth',
      usage: { input_tokens: 45, output_tokens: 14 },
    }, session)).toEqual({ outputTokens: 4, liveRateModel: null });
    expect(rows).toEqual([
      expect.objectContaining({
        payload: expect.objectContaining({ inputTokens: 5, outputTokens: 4 }),
      }),
    ]);
  });

  it('keeps positive multi-model reasoning in the unattributed bucket', () => {
    const session = internal();
    const { rows, emit } = emitter();

    reconcileClaudeFinalResultUsage(emit, 'fallback', {
      uuid: 'multi',
      usage: {
        input_tokens: 30,
        output_tokens: 10,
        output_tokens_details: { thinking_tokens: 7 },
      },
      modelUsage: {
        'model-a': { inputTokens: 10, outputTokens: 4 },
        'model-b': { inputTokens: 20, outputTokens: 6 },
      },
    }, session);

    expect(rows).toContainEqual(expect.objectContaining({
      payload: expect.objectContaining({
        messageId: 'result-delta-v2:multi:reasoning:unattributed',
        model: 'claude-unattributed-reasoning',
        reasoningTokens: 7,
      }),
    }));
  });
});
