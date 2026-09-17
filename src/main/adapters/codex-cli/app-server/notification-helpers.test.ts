import { describe, expect, it } from 'vitest';
import { formatRpcError, readTerminalError } from './notification-helpers';

describe('Codex app-server notification helpers', () => {
  it('formats structured JSON-RPC failures and treats obsolete string payloads as malformed', () => {
    expect(formatRpcError({ code: -32602, message: 'Invalid params' }))
      .toBe('Invalid params (code -32602)');
    expect(formatRpcError(undefined)).toBe('Unknown Codex app-server error');
    const obsolete = 'unstructured failure' as unknown as Parameters<typeof formatRpcError>[0];
    expect(formatRpcError(obsolete)).toBe('Unknown Codex app-server error');
  });

  it('surfaces terminal provider errors and ignores retry progress', () => {
    expect(readTerminalError({
      method: 'error',
      params: { error: { message: 'invalid_json_schema' }, willRetry: false },
    })?.message).toBe('invalid_json_schema');
    expect(readTerminalError({
      method: 'error',
      params: { error: { message: 'temporary' }, willRetry: true },
    })).toBeNull();
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
