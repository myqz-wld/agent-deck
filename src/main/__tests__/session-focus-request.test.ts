import { beforeEach, describe, expect, it } from 'vitest';
import {
  rememberSessionFocusRequest,
  takePendingSessionFocusRequest,
} from '../session-focus-request';

describe('pending session focus request', () => {
  beforeEach(() => {
    takePendingSessionFocusRequest();
  });

  it('survives until the renderer consumes it exactly once', () => {
    rememberSessionFocusRequest('session-1');
    expect(takePendingSessionFocusRequest()).toBe('session-1');
    expect(takePendingSessionFocusRequest()).toBeNull();
  });

  it('keeps the newest target when several requests arrive before mount', () => {
    rememberSessionFocusRequest('session-1');
    rememberSessionFocusRequest('session-2');
    expect(takePendingSessionFocusRequest()).toBe('session-2');
  });
});
