import { describe, expect, it } from 'vitest';
import { buildThreadStartParams, buildThreadResumeParams, buildTurnStartParams } from './thread-params';
import type { CodexThreadOptions } from '../sdk-bridge/thread-options-builder';

describe('Codex common permission presets on the native protocol', () => {
  it.each(['auto', 'bypassPermissions'] as const)('applies %s to start, resume, and every turn without expanding the sandbox', (permissionMode) => {
    const options: CodexThreadOptions = {
      workingDirectory: '/project', sandboxMode: 'read-only', skipGitRepoCheck: true,
      approvalPolicy: 'never', permissionMode,
    };
    const expected = permissionMode === 'auto'
      ? { approvalPolicy: 'on-request', approvalsReviewer: 'auto_review' }
      : { approvalPolicy: 'never', approvalsReviewer: 'user' };
    const start = buildThreadStartParams(options, null);
    const resume = buildThreadResumeParams('thread', options, null);
    const turn = buildTurnStartParams('thread', [], options, null);
    for (const params of [start, resume, turn]) expect(params).toMatchObject(expected);
    expect(start.sandbox).toBe('read-only');
    expect(resume.sandbox).toBe('read-only');
    expect(turn.sandboxPolicy).toMatchObject({ type: 'readOnly' });
  });

  it('does not relabel a legacy interactive session as automatic review', () => {
    const params = buildThreadStartParams({ workingDirectory: '/project', sandboxMode: 'workspace-write',
      skipGitRepoCheck: true, approvalPolicy: 'on-request' }, null);
    expect(params.approvalPolicy).toBe('on-request');
    expect(params).not.toHaveProperty('approvalsReviewer');
  });
});
