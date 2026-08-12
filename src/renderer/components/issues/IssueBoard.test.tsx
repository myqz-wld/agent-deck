// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { IssueRecord } from '@shared/types';
import { IssueBoard } from './IssueBoard';
import type { IssueFilters } from '@renderer/stores/issues-store';

afterEach(cleanup);

const issue = {
  id: 'issue-a',
  title: '窄屏问题',
  status: 'open',
  severity: 'medium',
  kind: 'app-bug',
  createdAt: 1,
  updatedAt: 1,
  deletedAt: null,
  branchName: null,
  cwd: null,
} as IssueRecord;

const baseProps = {
  filters: { statuses: ['open'] } as IssueFilters,
  issues: [issue],
  keywordInput: '',
  listError: null,
  loading: false,
  truncated: false,
  onFiltersChange: vi.fn(),
  onKeywordChange: vi.fn(),
};

describe('IssueBoard responsive navigation', () => {
  it('uses a single full-width list pane until an issue is selected', () => {
    render(
      <IssueBoard
        {...baseProps}
        selectedIssueId={null}
        onSelectIssue={vi.fn()}
        detail={<div>问题详情</div>}
      />,
    );
    expect(document.querySelector('[data-issue-pane="list"]')?.className)
      .toContain('w-full');
    expect(document.querySelector('[data-issue-pane="detail"]')?.className)
      .toContain('hidden');
    expect(screen.queryByRole('button', { name: '← 返回问题列表' })).toBeNull();
  });

  it('shows a narrow-screen detail pane with an explicit back action', () => {
    const onSelectIssue = vi.fn();
    render(
      <IssueBoard
        {...baseProps}
        selectedIssueId="issue-a"
        onSelectIssue={onSelectIssue}
        detail={<div>问题详情</div>}
      />,
    );
    expect(document.querySelector('[data-issue-pane="list"]')?.className)
      .toContain('hidden');
    expect(document.querySelector('[data-issue-pane="detail"]')?.className)
      .toContain('flex');
    fireEvent.click(screen.getByRole('button', { name: '← 返回问题列表' }));
    expect(onSelectIssue).toHaveBeenCalledWith(null);
  });
});
