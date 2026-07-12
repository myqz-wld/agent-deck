// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { IssueRecord } from '@shared/types';
import { ResolveInNewSessionDialog } from '../ResolveInNewSessionDialog';

let issuesResolveInNewSession: ReturnType<typeof vi.fn>;

function makeIssue(): IssueRecord {
  const now = Date.now();
  return {
    id: 'issue-1',
    title: '修复模型选择',
    description: '确保新会话使用所选模型',
    repro: null,
    kind: 'follow-up',
    status: 'open',
    severity: 'medium',
    sourceSessionId: 'source-session',
    cwd: '/repo',
    branchName: null,
    logsRef: null,
    resolutionSessionId: null,
    labels: [],
    createdAt: now,
    updatedAt: now,
    resolvedAt: null,
    deletedAt: null,
  };
}

beforeEach(() => {
  issuesResolveInNewSession = vi.fn();
  Object.defineProperty(window, 'api', {
    configurable: true,
    value: {
      listAdapters: vi.fn().mockResolvedValue([
        {
          id: 'codex-cli',
          displayName: 'Codex',
          capabilities: { canCreateSession: true, canSetPermissionMode: false },
        },
      ]),
      issuesResolveInNewSession,
    },
  });
});

afterEach(() => {
  cleanup();
  Reflect.deleteProperty(window, 'api');
});

describe('ResolveInNewSessionDialog model options', () => {
  it('把问题解决会话选择的模型与思考程度透传给 IPC', async () => {
    const issue = makeIssue();
    const updated = { ...issue, resolutionSessionId: 'resolution-session' };
    issuesResolveInNewSession.mockResolvedValue({
      sessionId: 'resolution-session',
      issue: updated,
    });
    const onResolved = vi.fn();
    render(
      <ResolveInNewSessionDialog
        issue={issue}
        onClose={vi.fn()}
        onResolved={onResolved}
      />,
    );

    await screen.findByText('Codex');
    fireEvent.change(screen.getByLabelText('模型'), {
      target: { value: 'gpt-custom-preview' },
    });
    fireEvent.click(screen.getByLabelText('思考程度'));
    fireEvent.click(screen.getByRole('option', { name: 'ULTRA' }));
    fireEvent.click(screen.getByRole('button', { name: '新建会话' }));

    await waitFor(() => {
      expect(issuesResolveInNewSession).toHaveBeenCalledWith(
        expect.objectContaining({
          issueId: 'issue-1',
          adapter: 'codex-cli',
          model: 'gpt-custom-preview',
          thinking: 'ultra',
        }),
      );
    });
    expect(onResolved).toHaveBeenCalledWith(updated);
  });
});
