import { render } from '@testing-library/react';
import { vi } from 'vitest';

import type { ExitPlanModeRequest } from '@shared/types';
import { PlanDeepReviewDialog } from './PlanDeepReviewDialog';

const request: ExitPlanModeRequest = {
  type: 'exit-plan-mode',
  requestId: 'plan-1',
  reviewSource: 'mcp',
  title: 'Lifecycle plan',
  plan: '## Plan\n\nSelected risk must be validated.\n\n1. Implement the gate.',
};

export function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

export function api(overrides: Record<string, unknown> = {}): Window['api'] {
  return {
    startPlanDeepReview: vi.fn(async () => ({
      sessionId: 'review-child',
      agentId: 'codex-cli',
    })),
    listEvents: vi.fn(async () => []),
    askPlanDeepReview: vi.fn(async () => true),
    generatePlanDeepReviewFeedback: vi.fn(async () => ({ feedback: 'Revise lifecycle checks.' })),
    ...overrides,
  } as unknown as Window['api'];
}

export function renderDialog(
  props: Partial<Parameters<typeof PlanDeepReviewDialog>[0]> = {},
) {
  const onClose = vi.fn();
  const onApprove = vi.fn(async () => true);
  const onRevise = vi.fn(async () => true);
  const view = render(
    <PlanDeepReviewDialog
      open
      sourceAgentId="codex-cli"
      sourceSessionId="source"
      request={request}
      decisionBusy={false}
      onClose={onClose}
      onApprove={onApprove}
      onRevise={onRevise}
      {...props}
    />,
  );
  return { onClose, onApprove, onRevise, unmount: view.unmount };
}
