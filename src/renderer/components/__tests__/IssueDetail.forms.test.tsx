// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react';
import type { IssueRecord } from '@shared/types';
import { useIssuesStore } from '@renderer/stores/issues-store';
import { IssueDetail } from '../IssueDetail';

function issue(overrides: Partial<IssueRecord> = {}): IssueRecord {
  return {
    id: 'issue-visible',
    title: 'Expandable issue',
    description: 'Original description',
    repro: 'Step one',
    kind: 'app-bug',
    status: 'open',
    severity: 'high',
    sourceSessionId: 'source-session',
    cwd: '/workspace/project',
    branchName: 'main',
    logsRef: {
      date: '2026-07-28',
      tsRange: { start: 1_753_689_600_000, end: 1_753_693_200_000 },
      scopes: ['renderer', 'review'],
      note: 'Primary log note',
    },
    resolutionSessionId: null,
    labels: ['renderer'],
    createdAt: 1,
    updatedAt: 2,
    resolvedAt: null,
    deletedAt: null,
    appendices: [
      {
        id: 42,
        issueId: 'issue-visible',
        body: 'Appendix evidence body',
        logsRef: {
          date: '2026-07-27',
          scopes: ['permission'],
          note: 'Appendix log note',
        },
        appendedSessionId: 'append-session-internal-id',
        appendedAt: 3,
      },
    ],
    ...overrides,
  };
}

beforeEach(() => {
  const record = issue();
  useIssuesStore.setState({
    issues: new Map([[record.id, record]]),
    selectedIssueId: record.id,
  });
  Object.defineProperty(window, 'api', {
    configurable: true,
    writable: true,
    value: {
      issuesGet: vi.fn(async () => record),
      issuesUpdate: vi.fn(async () => record),
      issuesSoftDelete: vi.fn(async () => undefined),
      issuesUndelete: vi.fn(async () => undefined),
    } as unknown as Window['api'],
  });
});

afterEach(() => cleanup());

describe('IssueDetail expandable evidence and drafts', () => {
  it('edits description through the shared expanded surface and restores trigger focus', async () => {
    render(<IssueDetail issueId="issue-visible" onClose={vi.fn()} />);
    await waitFor(() => expect(window.api.issuesGet).toHaveBeenCalled());
    const compact = screen.getByLabelText('Issue 描述') as HTMLTextAreaElement;
    const trigger = screen.getByRole('button', { name: '展开 Issue 描述' });
    expect(trigger.className).toContain('h-11');

    trigger.focus();
    fireEvent.click(trigger);
    const expanded = screen.getByLabelText('Issue 描述（展开）') as HTMLTextAreaElement;
    fireEvent.change(expanded, { target: { value: 'Edited from expanded view\nSecond line' } });
    expect(compact.value).toBe('Edited from expanded view\nSecond line');

    fireEvent.keyDown(screen.getByRole('dialog', { name: 'Issue 描述' }), { key: 'Escape' });
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Issue 描述' })).toBeNull());
    expect(document.activeElement).toBe(trigger);
    expect(compact.value).toBe('Edited from expanded view\nSecond line');
  });

  it('uses canonical Issue copy and full-width metadata punctuation', async () => {
    render(<IssueDetail issueId="issue-visible" onClose={vi.fn()} />);
    await waitFor(() => expect(window.api.issuesGet).toHaveBeenCalled());

    expect(screen.getByRole('heading', { name: 'Issue · issue-vi' })).toBeTruthy();
    expect(screen.getByText(`ID：${issue().id}`)).toBeTruthy();
    expect(screen.getByText(/来源会话：/)).toBeTruthy();
    expect(screen.getByText('工作目录：/workspace/project')).toBeTruthy();
    expect(screen.getByText('分支：main')).toBeTruthy();
    expect(screen.getByText(/创建：.*· 更新：/)).toBeTruthy();
    expect(screen.getByRole('button', { name: /新建处理会话/ })).toBeTruthy();
    expect(document.body.textContent).not.toContain('问题 ·');
    expect(document.body.textContent).not.toMatch(/(?:ID|来源会话|工作目录|分支|创建|更新):/);
  });

  it('uses the Issue entity name when the requested record is missing', async () => {
    window.api = {
      ...window.api,
      issuesGet: vi.fn(async () => null),
    };

    render(<IssueDetail issueId="issue-visible" onClose={vi.fn()} />);

    expect(await screen.findByText('未找到该 Issue')).toBeTruthy();
  });

  it('shows the main and every appendix log reference without exposing appendix ids', async () => {
    render(<IssueDetail issueId="issue-visible" onClose={vi.fn()} />);
    await waitFor(() => expect(window.api.issuesGet).toHaveBeenCalled());

    expect(screen.getByText('Primary log note')).toBeTruthy();
    expect(screen.getByText('Appendix log note')).toBeTruthy();
    expect(screen.getByText('permission')).toBeTruthy();
    expect(document.body.textContent).not.toContain('append-session-internal-id');

    fireEvent.click(screen.getByRole('button', { name: '展开补充记录' }));
    const dialog = screen.getByRole('dialog', { name: '补充记录详情' });
    expect(dialog.textContent).toContain('Appendix evidence body');
    expect(dialog.textContent).toContain('Appendix log note');
    expect(dialog.textContent).not.toContain('append-session-internal-id');
  });

  it('rebases a same-millisecond store event while preserving the local draft', async () => {
    render(<IssueDetail issueId="issue-visible" onClose={vi.fn()} />);
    await waitFor(() => expect(window.api.issuesGet).toHaveBeenCalled());

    const description = screen.getByLabelText('Issue 描述') as HTMLTextAreaElement;
    fireEvent.change(description, { target: { value: 'Local draft survives' } });

    act(() => {
      useIssuesStore.getState().upsertIssue(issue({
        title: 'Same millisecond server title',
        status: 'resolved',
        updatedAt: 2,
      }));
    });

    await waitFor(() => {
      expect((screen.getByLabelText('标题') as HTMLInputElement).value)
        .toBe('Same millisecond server title');
      expect(screen.getByLabelText('状态').textContent).toContain('resolved');
    });
    expect(description.value).toBe('Local draft survives');
  });
});
