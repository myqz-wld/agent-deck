import { describe, expect, it, vi } from 'vitest';
import { makeSessionRepoMock } from '@main/__tests__/_shared/mocks/session-repo';

vi.mock('@main/store/session-repo', () => ({
  sessionRepo: makeSessionRepoMock({}),
}));

import { resolveCallerSidForReadOnly } from '../transport-http';
import { denyExternalIfNotAllowed, makeCallerContext } from '../tools/helpers';
import {
  EXTERNAL_CALLER_SENTINEL,
  type McpAuthInfo,
} from '../types';
import { SPAWN_SESSION_SCHEMA } from '../tools/schemas/spawn';
import {
  GET_SESSION_SCHEMA,
  LIST_SESSIONS_SCHEMA,
  SEND_MESSAGE_SCHEMA,
  SHUTDOWN_SESSION_SCHEMA,
} from '../tools/schemas/session';
import { ENTER_WORKTREE_SCHEMA } from '../tools/schemas/lifecycle';
import { TASK_CREATE_SCHEMA } from '../tools/schemas/tasks';
import { REPORT_ISSUE_SCHEMA } from '../tools/schemas/issues';
import { BROWSER_OPEN_SCHEMA } from '../tools/schemas/browser';

describe('MCP caller identity boundary', () => {
  it('forces global-token and missing-auth callers to the external sentinel', () => {
    const forged = {
      authInfo: {
        resolvedSid: 'victim-session',
        fallbackToGlobal: true,
      } satisfies McpAuthInfo,
    };
    expect(resolveCallerSidForReadOnly(forged)).toBe(EXTERNAL_CALLER_SENTINEL);
    expect(resolveCallerSidForReadOnly()).toBe(EXTERNAL_CALLER_SENTINEL);
  });

  it('uses the authenticated per-session HTTP identity', () => {
    const extra = {
      authInfo: {
        resolvedSid: 'real-session',
        fallbackToGlobal: false,
      } satisfies McpAuthInfo,
    };
    expect(resolveCallerSidForReadOnly(extra)).toBe('real-session');
  });

  it('denies external writes while retaining allowed read-only discovery', () => {
    const external = makeCallerContext(EXTERNAL_CALLER_SENTINEL, 'http');
    expect(denyExternalIfNotAllowed('spawn_session', external)?.isError).toBe(true);
    expect(denyExternalIfNotAllowed('send_message', external)?.isError).toBe(true);
    expect(denyExternalIfNotAllowed('list_sessions', external)).toBeNull();
  });

  it('does not reject a real HTTP caller before repository validation', () => {
    const authenticated = makeCallerContext('real-session', 'http');
    expect(denyExternalIfNotAllowed('spawn_session', authenticated)).toBeNull();
  });

  it('does not publish callerSessionId in any representative public schema', () => {
    for (const schema of [
      SPAWN_SESSION_SCHEMA,
      SEND_MESSAGE_SCHEMA,
      LIST_SESSIONS_SCHEMA,
      GET_SESSION_SCHEMA,
      SHUTDOWN_SESSION_SCHEMA,
      ENTER_WORKTREE_SCHEMA,
      TASK_CREATE_SCHEMA,
      REPORT_ISSUE_SCHEMA,
      BROWSER_OPEN_SCHEMA,
    ]) {
      expect(schema).not.toHaveProperty('callerSessionId');
    }
  });
});
