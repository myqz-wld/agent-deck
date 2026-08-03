import { RequestError } from '@agentclientprotocol/sdk';
import { describe, expect, it } from 'vitest';

import {
  grokContextWindowRejectionFromRequestError,
  structuredGrokContextWindowRejectionCode,
} from '../native-error';
import {
  grokPromptCompleteFromExtension,
  parseGrokPromptCompleteNotification,
} from '../extension';

describe('Grok native context rejection evidence', () => {
  it.each([
    ['context_length_exceeded'],
    ['context_window_exceeded'],
    ['model_context_window_exceeded'],
  ] as const)('accepts allowlisted structured code %s', (code) => {
    const error = new RequestError(-32_000, 'provider request failed', {
      error: { code },
    });

    expect(grokContextWindowRejectionFromRequestError(error)).toBe(code);
  });

  it('reads bounded nested native error fields', () => {
    expect(structuredGrokContextWindowRejectionCode({
      details: { error: { error_type: 'context_length_exceeded' } },
    })).toBe('context_length_exceeded');
  });

  it('does not classify free text or a non-native lookalike error', () => {
    expect(grokContextWindowRejectionFromRequestError(
      new RequestError(-32_000, 'context_length_exceeded', {
        error: { message: 'context_window_exceeded' },
      }),
    )).toBeNull();
    expect(grokContextWindowRejectionFromRequestError({
      name: 'RequestError',
      data: { code: 'context_length_exceeded' },
    })).toBeNull();
  });

  it('does not scan arbitrary strings or arrays outside allowlisted code slots', () => {
    expect(structuredGrokContextWindowRejectionCode({
      message: 'context_length_exceeded',
      errors: [{ code: 'context_window_exceeded' }],
    })).toBeNull();
  });

  it('preserves structured rejection evidence from both Grok terminal rails', () => {
    expect(parseGrokPromptCompleteNotification({
      sessionId: 'native',
      stopReason: 'failed',
      error: { type: 'context_window_exceeded' },
    })).toMatchObject({
      contextWindowRejectionCode: 'context_window_exceeded',
    });

    expect(grokPromptCompleteFromExtension({
      sessionId: 'native',
      update: {
        sessionUpdate: 'turn_completed',
        prompt_id: 'prompt-1',
        stop_reason: 'failed',
        error: { code: 'model_context_window_exceeded' },
      },
      _meta: { agentTimestampMs: 10 },
    }, 1)).toMatchObject({
      contextWindowRejectionCode: 'model_context_window_exceeded',
    });
  });
});
