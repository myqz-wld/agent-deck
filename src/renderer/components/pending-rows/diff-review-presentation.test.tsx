// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from '@testing-library/react';
import type { AgentEvent, DiffReviewRequest } from '@shared/types';
import {
  DiffIntroCards,
  DiffPresentationPanel,
  buildPrDiffPayload,
} from './diff-review-presentation';
import { DiffReviewRow } from './DiffReviewRow';

afterEach(() => cleanup());

describe('diff review presentation', () => {
  it('keeps every conflict pane and review field lazy but typed in the expanded heavy view', () => {
    const payload: DiffReviewRequest = {
      type: 'diff-review',
      requestId: 'typed-conflict',
      mode: 'merge-conflict',
      title: 'Resolve lifecycle conflict',
      filePath: '/workspace/lifecycle.ts',
      language: 'typescript',
      rationale: 'Preserve both lifecycle guarantees.',
      instructions: 'Verify the suggested result before approval.',
      annotations: [
        {
          pane: 'resolution',
          line: 1,
          title: 'Combined guarantee',
          body: 'The result retains both checks.',
        },
      ],
      conflict: {
        base: 'base-state',
        baseLabel: '共同版本',
        ours: 'local-state',
        oursLabel: '本地版本',
        theirs: 'incoming-state',
        theirsLabel: '传入版本',
        resolution: 'resolved-state',
        resolutionLabel: '建议版本',
      },
    };
    render(
      <DiffPresentationPanel
        payload={payload}
        diffPayload={null}
        sessionId="codex-1"
      />,
    );

    expect(screen.queryByText('base-state')).toBeNull();
    expect(screen.queryByText('resolved-state')).toBeNull();
    const trigger = screen.getByRole('button', { name: '展开冲突内容' });
    expect(trigger.className).toContain('h-11');
    fireEvent.click(trigger);

    const dialog = screen.getByRole('dialog', { name: 'Resolve lifecycle conflict' });
    expect(within(dialog).getByText('Preserve both lifecycle guarantees.')).toBeTruthy();
    expect(within(dialog).getByText('Verify the suggested result before approval.')).toBeTruthy();
    expect(within(dialog).getByText('base-state')).toBeTruthy();
    expect(within(dialog).getByText('local-state')).toBeTruthy();
    expect(within(dialog).getByText('incoming-state')).toBeTruthy();
    expect(within(dialog).getByText('resolved-state')).toBeTruthy();
    expect(within(dialog).getByText('Combined guarantee')).toBeTruthy();
    expect(dialog.querySelector('[data-expandable-heavy-view="custom"]')).toBeTruthy();
  });

  it('keeps rationale and instructions as separate intro cards', () => {
    render(
      <DiffIntroCards
        rationale="This fragment moves filtering before merge."
        instructions="Confirm closed-session cancellations still appear."
      />,
    );

    expect(screen.getByText('变更缘由')).toBeTruthy();
    expect(screen.getByText('This fragment moves filtering before merge.')).toBeTruthy();
    expect(screen.getByText('确认点')).toBeTruthy();
    expect(screen.getByText('Confirm closed-session cancellations still appear.')).toBeTruthy();
  });

  it('lets the rationale card use the full row when instructions are absent', () => {
    render(<DiffIntroCards rationale="Only a change reason is present." />);

    expect(screen.getByTestId('diff-intro-grid').className).not.toContain('md:grid-cols-2');
    expect(screen.getByText('Only a change reason is present.')).toBeTruthy();
    expect(screen.queryByText('确认点')).toBeNull();
  });

  it('renders PR annotation cards in the requested panes after expanding', () => {
    const payload: DiffReviewRequest = {
      type: 'diff-review',
      requestId: 'mcp-diff-test',
      mode: 'pr',
      rationale: 'Explain the rename.',
      annotations: [
        {
          pane: 'after',
          line: 2,
          title: 'Rename reason',
          body: 'The proposed name matches the API payload.',
        },
        {
          pane: 'both',
          line: 0,
          body: 'The caller remains the same on both sides.',
        },
      ],
      pr: {
        before: 'const name = user.name;\nreturn name;',
        after: 'const displayName = user.profile.displayName;\nreturn displayName;',
      },
    };

    render(
      <DiffPresentationPanel
        payload={payload}
        diffPayload={buildPrDiffPayload(payload)}
        sessionId="codex-1"
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: /展开差异/ }));

    expect(screen.getAllByTestId('diff-annotation-card')).toHaveLength(3);
    expect(screen.getByText('Rename reason')).toBeTruthy();
    expect(screen.getByText('The proposed name matches the API payload.')).toBeTruthy();
    expect(screen.getAllByText('The caller remains the same on both sides.')).toHaveLength(2);
  });

  it('keeps red and green diff cues when PR annotation cards are present', () => {
    const payload: DiffReviewRequest = {
      type: 'diff-review',
      requestId: 'mcp-diff-tones',
      mode: 'pr',
      rationale: 'Explain the inserted branch.',
      annotations: [
        {
          pane: 'after',
          line: 2,
          body: 'The added branch is intentionally highlighted and annotated.',
        },
      ],
      pr: {
        before: 'const state = loadState();\nreturn state;',
        after: 'const state = loadState();\nconst ready = state.ready;\nreturn ready ? state : null;',
      },
    };

    render(
      <DiffPresentationPanel
        payload={payload}
        diffPayload={buildPrDiffPayload(payload)}
        sessionId="codex-1"
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: /展开差异/ }));

    const dialog = screen.getByRole('dialog', { name: '差异详情' });
    const deletedRows = dialog.querySelectorAll('[data-diff-tone="deleted"]');
    const addedRows = dialog.querySelectorAll('[data-diff-tone="added"]');
    expect(deletedRows.length).toBeGreaterThan(0);
    expect(addedRows.length).toBeGreaterThan(0);
    expect(deletedRows[0]?.className).toContain('bg-status-error');
    expect(addedRows[0]?.className).toContain('bg-status-working');
    expect(screen.getByText('The added branch is intentionally highlighted and annotated.')).toBeTruthy();
  });

  it('renders merge-conflict annotations in the resolution pane', () => {
    const payload: DiffReviewRequest = {
      type: 'diff-review',
      requestId: 'mcp-diff-conflict',
      mode: 'merge-conflict',
      rationale: 'Explain the resolution.',
      annotations: [
        {
          pane: 'resolution',
          line: 1,
          title: 'Resolution choice',
          body: 'This keeps the local state field and incoming validation.',
        },
      ],
      conflict: {
        ours: 'state: local',
        theirs: 'validate: incoming',
        resolution: 'state: local\nvalidate: incoming',
      },
    };

    render(<DiffPresentationPanel payload={payload} diffPayload={null} sessionId="codex-1" />);

    fireEvent.click(screen.getByRole('button', { name: /展开冲突/ }));

    expect(screen.getByText('Resolution choice')).toBeTruthy();
    expect(screen.getByText('This keeps the local state field and incoming validation.')).toBeTruthy();
  });

  it('keeps bottom padding in unannotated conflict panes after expanding', () => {
    const payload: DiffReviewRequest = {
      type: 'diff-review',
      requestId: 'mcp-diff-conflict-padding',
      mode: 'merge-conflict',
      rationale: 'Review the proposed resolution.',
      conflict: {
        ours: 'local line',
        theirs: 'incoming line',
        resolution: 'local line\nincoming line',
      },
    };

    render(
      <DiffPresentationPanel payload={payload} diffPayload={null} sessionId="codex-1" />,
    );

    fireEvent.click(screen.getByRole('button', { name: /展开冲突/ }));

    const paneBody = screen
      .getByRole('dialog', { name: '冲突解决详情' })
      .querySelector('pre');
    expect(paneBody?.className).toContain('pb-5');
  });
});

describe('DiffReviewRow feedback', () => {
  it('uses multiline feedback, expands the draft, and handles response failure locally', async () => {
    const payload: DiffReviewRequest = {
      type: 'diff-review',
      requestId: 'diff-feedback',
      mode: 'pr',
      rationale: 'Review this change.',
      pr: {
        before: 'before',
        after: 'after',
      },
    };
    const event: AgentEvent = {
      sessionId: 'codex-1',
      agentId: 'codex-cli',
      kind: 'waiting-for-user',
      payload,
      ts: 1,
    };
    const respondDiffReview = vi.fn(async () => {
      throw new Error('transport details');
    });
    Object.defineProperty(window, 'api', {
      configurable: true,
      writable: true,
      value: { respondDiffReview } as unknown as Window['api'],
    });
    render(
      <DiffReviewRow
        event={event}
        payload={payload}
        sessionId="codex-1"
        agentId="codex-cli"
        isSdk
        stillPending
        wasCancelled={false}
        onResolved={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: '提修改意见' }));
    const feedback = screen.getByLabelText('差异修改意见') as HTMLTextAreaElement;
    fireEvent.change(feedback, { target: { value: 'First line\nSecond line' } });
    fireEvent.click(screen.getByRole('button', { name: '展开差异修改意见' }));
    const expandedFeedback = screen.getByLabelText(
      '差异修改意见（展开）',
    ) as HTMLTextAreaElement;
    expect(expandedFeedback.value)
      .toBe('First line\nSecond line');
    fireEvent.keyDown(expandedFeedback, { key: 'Enter' });
    expect(respondDiffReview).not.toHaveBeenCalled();
    fireEvent.keyDown(expandedFeedback, { key: 'Enter', metaKey: true });

    await waitFor(() => expect(respondDiffReview).toHaveBeenCalledWith(
      'codex-cli',
      'codex-1',
      'diff-feedback',
      { decision: 'revise', feedback: 'First line\nSecond line' },
    ));
    expect((await screen.findByRole('alert', { hidden: true })).textContent)
      .toBe('差异响应失败，请确认内容仍在等待后重试。');
    expect(screen.queryByText('transport details')).toBeNull();
  });
});
