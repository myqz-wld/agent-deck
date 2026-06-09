import { beforeEach, describe, expect, it, vi } from 'vitest';
import log from 'electron-log/main';
import { parseStringArrayJson } from '../types';

const logger = log.scope('session-repo');

describe('session-repo/types parseStringArrayJson logging', () => {
  beforeEach(() => {
    (logger.warn as ReturnType<typeof vi.fn>).mockClear();
  });

  it('NULL / empty string stay silent because they mean unset', () => {
    expect(parseStringArrayJson(null, { sessionId: 's1', field: 'additional_directories' })).toBeNull();
    expect(parseStringArrayJson('', { sessionId: 's1', field: 'additional_directories' })).toBeNull();
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it('malformed JSON falls back to null and logs session + field context', () => {
    expect(parseStringArrayJson('not json{', {
      sessionId: 's-bad',
      field: 'additional_directories',
    })).toBeNull();
    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining('[session-repo] string[] JSON parse failed'),
      expect.objectContaining({
        sessionId: 's-bad',
        field: 'additional_directories',
        rawLength: 9,
      }),
      expect.any(Error),
    );
  });

  it('wrong JSON shape logs before falling back to null', () => {
    expect(parseStringArrayJson(JSON.stringify({ path: '/tmp' }), {
      sessionId: 's-shape',
      field: 'extra_allow_write',
    })).toBeNull();
    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining('[session-repo] string[] JSON is not an array'),
      expect.objectContaining({
        sessionId: 's-shape',
        field: 'extra_allow_write',
        rawType: 'object',
      }),
    );
  });

  it('mixed array keeps valid strings and logs dropped entries', () => {
    expect(parseStringArrayJson(JSON.stringify(['/ok', 123, '', '/also-ok']), {
      sessionId: 's-mixed',
      field: 'additional_directories',
    })).toEqual(['/ok', '/also-ok']);
    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining('[session-repo] string[] JSON dropped invalid entries'),
      expect.objectContaining({
        sessionId: 's-mixed',
        field: 'additional_directories',
        total: 4,
        valid: 2,
      }),
    );
  });
});
