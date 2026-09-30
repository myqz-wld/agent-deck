import type { FeishuPendingCard, FeishuSubscriptionRecord } from './types';

export function feishuPendingSource(sessionId: string, subscriptions: readonly FeishuSubscriptionRecord[]): string {
  return subscriptions.find(s => s.sessionId === sessionId)?.purpose === 'assistant' ? '助手'
    : `工作会话 · ${sessionId.slice(0, 8)}`;
}

/** Interactive requests always identify the conversation they will affect. */
export function labelFeishuPendingSources(
  cards: readonly FeishuPendingCard[],
  subscriptions: readonly FeishuSubscriptionRecord[],
): FeishuPendingCard[] {
  return cards.map(card => {
    const source = feishuPendingSource(card.sessionId, subscriptions);
    return { ...card, title: `${source} · ${card.title}` };
  });
}
