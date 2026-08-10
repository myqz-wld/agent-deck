import { describe, expect, it } from 'vitest';
import {
  createPermissionPreviewDisplay,
  MCP_DIFF_PRESENTATION_SCHEMA,
  MCP_PLAN_PRESENTATION_SCHEMA,
} from '@contracts/index';

import { parseRemoteHostPendingListResult } from './business-validation';

function result(questionIds?: unknown) {
  return {
    requests: [{
      id: 'request-1',
      sessionId: 'session-1',
      kind: 'ask-user-question',
      status: 'pending',
      createdAt: 1,
      expiresAt: null,
      display: questionIds === undefined ? {} : { questionIds },
    }],
    revision: 2,
  };
}

describe('remote host pending result validation', () => {
  it('accepts missing questionIds for the authoritative answer fallback', () => {
    expect(parseRemoteHostPendingListResult(result(), 'session-1')).toMatchObject({
      requests: [{ display: {} }],
    });
  });

  it.each([
    { questionIds: [] },
    { questionIds: ['duplicate', 'duplicate'] },
    { questionIds: ['line\u0000break'] },
  ])('rejects malformed bounded questionIds: $questionIds', ({ questionIds }) => {
    expect(() => parseRemoteHostPendingListResult(
      result(questionIds),
      'session-1',
    )).toThrow('malformed question ids');
  });

  it('accepts the larger exact MCP presentation envelope and rejects kind drift', () => {
    const presentation = {
      requests: [{
        id: 'plan-1',
        sessionId: 'session-1',
        kind: 'exit-plan',
        status: 'pending',
        createdAt: 1,
        expiresAt: null,
        display: {
          schema: MCP_PLAN_PRESENTATION_SCHEMA,
          plan: 'x'.repeat(70_000),
        },
      }],
      revision: 3,
    };
    expect(parseRemoteHostPendingListResult(presentation, 'session-1'))
      .toMatchObject({ requests: [{ kind: 'exit-plan' }] });
    expect(() => parseRemoteHostPendingListResult({
      ...presentation,
      requests: [{
        ...presentation.requests[0],
        kind: 'diff-review',
      }],
    }, 'session-1')).toThrow('invalid MCP presentation');
    expect(() => parseRemoteHostPendingListResult({
      ...presentation,
      requests: [{
        ...presentation.requests[0],
        kind: 'diff-review',
        display: {
          schema: MCP_DIFF_PRESENTATION_SCHEMA,
          mode: 'pr',
          rationale: 'review',
          pr: { before: '', after: '', leaked: true },
        },
      }],
    }, 'session-1')).toThrow('invalid MCP presentation');
  });

  it('accepts only the exact bounded permission preview schema', () => {
    const display = createPermissionPreviewDisplay('Edit', {
      file_path: '/workspace/app.ts', old_string: 'before', new_string: 'after',
    });
    const permission = {
      requests: [{
        id: 'permission-1', sessionId: 'session-1', kind: 'permission', status: 'pending',
        createdAt: 1, expiresAt: null, display,
      }],
      revision: 3,
    };
    expect(parseRemoteHostPendingListResult(permission, 'session-1'))
      .toMatchObject({ requests: [{ display: { complete: true } }] });
    expect(() => parseRemoteHostPendingListResult({
      ...permission,
      requests: [{ ...permission.requests[0], display: { ...display, complete: 'yes' } }],
    }, 'session-1')).toThrow('invalid permission preview');
  });
});
