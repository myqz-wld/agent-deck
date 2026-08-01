// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import type { AgentEvent, DiffReviewRequest } from '@shared/types';

vi.mock('@renderer/components/diff/DiffViewer', () => ({
  DiffViewer: () => <div>diff</div>,
}));
vi.mock('@renderer/utils/logger', () => ({
  default: { scope: () => ({ error: vi.fn(), warn: vi.fn() }) },
}));

import { DiffReviewRow } from './DiffReviewRow';

afterEach(() => {
  cleanup();
  Reflect.deleteProperty(window, 'api');
});

describe('DiffReviewRow transferred delivery failure', () => {
  it('keeps the pending card actionable when the awaited IPC response rejects', async () => {
    const payload: DiffReviewRequest = {
      type: 'diff-review',
      requestId: 'diff-1',
      mode: 'pr',
      rationale: 'Review this change.',
      pr: { before: 'old', after: 'new' },
    };
    const event: AgentEvent = {
      sessionId: 'successor',
      agentId: 'codex-cli',
      kind: 'waiting-for-user',
      payload,
      ts: 1,
      source: 'sdk',
    };
    const onResolved = vi.fn();
    Object.defineProperty(window, 'api', {
      configurable: true,
      value: {
        respondDiffReview: vi.fn(async () => {
          throw new Error('late delivery failed');
        }),
      } as unknown as Window['api'],
    });

    render(
      <DiffReviewRow
        event={event}
        payload={payload}
        sessionId="successor"
        agentId="codex-cli"
        isSdk
        stillPending
        wasCancelled={false}
        onResolved={onResolved}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: '确认片段' }));

    expect((await screen.findByRole('alert')).textContent)
      .toBe('差异响应失败，请确认内容仍在等待后重试。');
    expect(onResolved).not.toHaveBeenCalled();
    expect((screen.getByRole('button', { name: '确认片段' }) as HTMLButtonElement).disabled)
      .toBe(false);
  });
});
