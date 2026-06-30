// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import type { DiffReviewRequest } from '@shared/types';
import {
  DiffIntroCards,
  DiffPresentationPanel,
  buildPrDiffPayload,
} from './diff-review-presentation';

afterEach(() => cleanup());

describe('diff review presentation', () => {
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

    const { container } = render(
      <DiffPresentationPanel
        payload={payload}
        diffPayload={buildPrDiffPayload(payload)}
        sessionId="codex-1"
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: /展开差异/ }));

    const deletedRows = container.querySelectorAll('[data-diff-tone="deleted"]');
    const addedRows = container.querySelectorAll('[data-diff-tone="added"]');
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

    const { container } = render(
      <DiffPresentationPanel payload={payload} diffPayload={null} sessionId="codex-1" />,
    );

    fireEvent.click(screen.getByRole('button', { name: /展开冲突/ }));

    const paneBody = container.querySelector('pre');
    expect(paneBody?.className).toContain('pb-5');
  });
});
