import { beforeEach, describe, expect, it } from 'vitest';
import { usePlanDeepReviewStore } from '../plan-deep-review-store';

beforeEach(() => {
  usePlanDeepReviewStore.setState({ drafts: new Map() });
});

describe('plan deep review store', () => {
  it('retains draft state by request and applies functional updates', () => {
    const store = usePlanDeepReviewStore.getState();
    store.patchDraft('plan-1', {
      question: 'Keep this question.',
      questionBusy: true,
    });
    store.patchDraft('plan-1', (current) => ({
      feedback: `${current.question} Feedback`,
    }));

    expect(usePlanDeepReviewStore.getState().drafts.get('plan-1')).toMatchObject({
      question: 'Keep this question.',
      questionBusy: true,
      feedback: 'Keep this question. Feedback',
    });
  });

  it('does not recreate a resolved draft from a late async completion', () => {
    const store = usePlanDeepReviewStore.getState();
    store.patchDraft('plan-1', { questionBusy: true });
    store.clearDraft('plan-1');
    store.patchExistingDraft('plan-1', { questionBusy: false });

    expect(usePlanDeepReviewStore.getState().drafts.has('plan-1')).toBe(false);
  });
});
