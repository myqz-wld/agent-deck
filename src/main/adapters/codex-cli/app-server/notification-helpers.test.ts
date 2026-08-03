import { describe, expect, it } from 'vitest';
import { readTerminalError, readTerminalErrorText } from './notification-helpers';

describe('Codex app-server notification helpers', () => {
  it('surfaces terminal provider errors and ignores retry progress', () => {
    expect(readTerminalErrorText({
      method: 'error',
      params: { error: { message: 'invalid_json_schema' }, willRetry: false },
    })).toBe('invalid_json_schema');
    expect(readTerminalErrorText({
      method: 'error',
      params: { error: { message: 'temporary' }, willRetry: true },
    })).toBe('');
  });

  it('preserves the native structured error classification without inferring from text', () => {
    expect(readTerminalError({
      method: 'turn/completed',
      params: {
        turn: {
          status: 'failed',
          error: {
            message: 'request too large',
            codexErrorInfo: 'contextWindowExceeded',
          },
        },
      },
    })).toEqual({
      message: 'request too large',
      codexErrorInfo: 'contextWindowExceeded',
    });
    expect(readTerminalError({
      method: 'error',
      params: {
        willRetry: false,
        error: { message: 'contextWindowExceeded appears in free text' },
      },
    })).toEqual({
      message: 'contextWindowExceeded appears in free text',
      codexErrorInfo: null,
    });
  });
});
