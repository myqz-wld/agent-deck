import { describe, expect, it } from 'vitest';
import { readTerminalErrorText } from './notification-helpers';

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
});
