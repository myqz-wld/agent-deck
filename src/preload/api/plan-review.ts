import { ipcRenderer } from 'electron';
import { IpcInvoke } from '@shared/ipc-channels';
import type { PlanDeepReviewSession } from '@shared/types';

export const planReviewApi = {
  startPlanDeepReview: (
    sessionId: string,
    requestId: string,
  ): Promise<PlanDeepReviewSession> =>
    ipcRenderer.invoke(IpcInvoke.PlanReviewStartDeepReview, sessionId, requestId),
  askPlanDeepReview: (
    sessionId: string,
    requestId: string,
    question: string,
  ): Promise<boolean> =>
    ipcRenderer.invoke(IpcInvoke.PlanReviewAskDeepReview, sessionId, requestId, question),
  autoFeedbackPlanDeepReview: (
    sessionId: string,
    requestId: string,
  ): Promise<{ feedback: string }> =>
    ipcRenderer.invoke(IpcInvoke.PlanReviewAutoFeedback, sessionId, requestId),
};
