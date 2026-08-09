import { describe, expect, it } from 'vitest';

import {
  parseSessionTaskListParams,
  parseSessionTaskListResult,
  SESSION_TASK_MAX_ITEMS,
} from './session-tasks';

function task() {
  return {
    id: 'task-1',
    ownerSessionId: 'session-1',
    teamId: null,
    subject: '验证远程任务',
    description: null,
    status: 'active',
    activeForm: '正在验证远程任务',
    priority: 5,
    blocks: [],
    blockedBy: [],
    labels: ['remote'],
    createdAt: '2026-08-07T00:00:00.000Z',
    updatedAt: '2026-08-07T00:01:00.000Z',
  };
}

describe('session task contracts', () => {
  it('accepts one exact bounded task page', () => {
    expect(parseSessionTaskListParams({ sessionId: 'session-1', limit: 50 })).toEqual({
      sessionId: 'session-1',
      limit: 50,
    });
    expect(parseSessionTaskListResult({ tasks: [task()], revision: 7 }, 50)).toEqual({
      tasks: [task()],
      revision: 7,
    });
  });

  it('rejects extra fields, duplicate ids, and an excessive limit', () => {
    expect(() => parseSessionTaskListParams({
      sessionId: 'session-1', limit: SESSION_TASK_MAX_ITEMS + 1,
    })).toThrow();
    expect(() => parseSessionTaskListResult({ tasks: [task(), task()], revision: 7 }, 50)).toThrow();
    expect(() => parseSessionTaskListResult({
      tasks: [{ ...task(), hostPath: '/private/worker' }], revision: 7,
    }, 50)).toThrow();
  });
});
