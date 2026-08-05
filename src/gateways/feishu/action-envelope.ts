import type { FeishuPendingAction } from '@gateways/im';

export const FEISHU_ACTION_PROTOCOL = 'agent-deck.pending.v1';

export interface FeishuQuestionFieldBinding {
  providerKey: string;
  questionId: string;
}

export interface FeishuCardActionEnvelope {
  protocol: typeof FEISHU_ACTION_PROTOCOL;
  action: Omit<FeishuPendingAction, 'value'>;
  expiresAt: number | null;
  fields?: readonly FeishuQuestionFieldBinding[];
}
