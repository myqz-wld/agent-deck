import { describe, expect, it, vi } from 'vitest';
import { makeSessionRepoMock } from '@main/__tests__/_shared/mocks/session-repo';

vi.mock('@main/store/session-repo', () => ({
  sessionRepo: makeSessionRepoMock({}),
}));

import { denyExternalIfNotAllowed } from '../tools/helpers';
import {
  EXTERNAL_CALLER_SENTINEL,
  type CallerContext,
} from '../types';

function ctx(
  callerSessionId: string,
  transport: CallerContext['transport'],
): CallerContext {
  return { callerSessionId, transport };
}

describe('denyExternalIfNotAllowed', () => {
  it('allows authenticated in-process and HTTP callers through this guard', () => {
    expect(denyExternalIfNotAllowed('spawn_session', ctx('sdk-session', 'in-process'))).toBeNull();
    expect(denyExternalIfNotAllowed('spawn_session', ctx('http-session', 'http'))).toBeNull();
  });

  it('denies every external write tool', () => {
    const external = ctx(EXTERNAL_CALLER_SENTINEL, 'http');
    for (const tool of [
      'spawn_session',
      'send_message',
      'present_plan',
      'present_diff',
      'shutdown_session',
      'hand_off_session',
      'enter_worktree',
      'exit_worktree',
    ] as const) {
      expect(denyExternalIfNotAllowed(tool, external)?.isError).toBe(true);
    }
  });

  it('allows explicitly public read-only discovery for the external sentinel', () => {
    const external = ctx(EXTERNAL_CALLER_SENTINEL, 'http');
    expect(denyExternalIfNotAllowed('list_sessions', external)).toBeNull();
    expect(denyExternalIfNotAllowed('get_session', external)).toBeNull();
    expect(denyExternalIfNotAllowed('task_list', external)).toBeNull();
  });
});
