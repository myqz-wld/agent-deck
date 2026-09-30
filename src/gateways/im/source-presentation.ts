import type { FeishuPendingCard, FeishuSubscriptionRecord } from './types';

/** Interactive requests always identify the conversation they will affect. */
export function labelFeishuPendingSources(
  cards: readonly FeishuPendingCard[],
  subscriptions: readonly FeishuSubscriptionRecord[],
): FeishuPendingCard[] {
  return cards.map(card => {
    const purpose = subscriptions.find(s => s.sessionId === card.sessionId)?.purpose;
    const source = purpose === 'assistant' ? '助手' : `工作会话 · ${card.sessionId.slice(0, 8)}`;
    return { ...card, title: `${source} · ${card.title}` };
  });
}
