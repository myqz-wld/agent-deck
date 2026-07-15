import { IpcInvoke } from '@shared/ipc-channels';
import { MAX_USER_MESSAGE_LENGTH } from '@shared/message-limits';
import { planReviewService } from '@main/plan-review/service';
import { IpcInputError, on, parseStringId } from './_helpers';

export function registerPlanReviewIpc(): void {
  on(IpcInvoke.PlanReviewStartDeepReview, async (_event, sessionId, requestId) => {
    return planReviewService.startDeepReview(
      parseStringId('sessionId', sessionId),
      parseStringId('requestId', requestId),
    );
  });

  on(IpcInvoke.PlanReviewAskDeepReview, async (_event, sessionId, requestId, question) => {
    if (typeof question !== 'string') {
      throw new IpcInputError('question', 'must be string');
    }
    if (question.length > MAX_USER_MESSAGE_LENGTH) {
      throw new IpcInputError(
        'question',
        `> ${MAX_USER_MESSAGE_LENGTH} chars (got ${question.length.toLocaleString()} chars)`,
      );
    }
    await planReviewService.askDeepReview(
      parseStringId('sessionId', sessionId),
      parseStringId('requestId', requestId),
      question,
    );
    return true;
  });

  on(IpcInvoke.PlanReviewAutoFeedback, async (_event, sessionId, requestId) => {
    const feedback = await planReviewService.generateAndSubmitFeedback(
      parseStringId('sessionId', sessionId),
      parseStringId('requestId', requestId),
    );
    return { feedback };
  });
}
