import type { FeishuPendingCard, FeishuSubscriptionRecord } from './types';
import { feishuWorkName } from './session-names';

export function feishuPendingSource(sessionId: string, subscriptions: readonly FeishuSubscriptionRecord[],
  titles: Readonly<Record<string, string>> = {}): string {
  return subscriptions.find(s => s.sessionId === sessionId)?.purpose === 'assistant' ? '助手'
    : titles[sessionId] ? feishuWorkName(titles[sessionId]) : `工作会话 · ${sessionId.slice(0, 8)}`;
}

/** Interactive requests always identify the conversation they will affect. */
export function labelFeishuPendingSources(
  cards: readonly FeishuPendingCard[],
  subscriptions: readonly FeishuSubscriptionRecord[],
  titles: Readonly<Record<string, string>> = {},
): FeishuPendingCard[] {
  return cards.map(card => {
    const source = feishuPendingSource(card.sessionId, subscriptions, titles);
    return { ...card, title: `${source} · ${card.title}` };
  });
}
