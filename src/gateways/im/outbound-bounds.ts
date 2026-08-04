import { FeishuGatewayError } from './errors';
import { truncateUtf8 } from './redaction';
import type { FeishuOutboundMessage, FeishuPendingCard } from './types';

export function canonicalJsonBytes(value: unknown): number {
  return new TextEncoder().encode(JSON.stringify(value)).byteLength;
}

const READ_ONLY_WARNING = 'Approval context exceeds the safe Feishu bound; open a full client.';

function minimalNonActionCard(card: FeishuPendingCard): FeishuPendingCard {
  return {
    ...card,
    title: truncateUtf8(card.title, 128),
    display: {},
    buttons: [],
  };
}

function readOnlyActionCard(card: FeishuPendingCard): FeishuPendingCard {
  return {
    ...card,
    title: 'Read-only approval notice',
    display: {
      warning: READ_ONLY_WARNING,
      sessionId: card.sessionId,
      requestId: card.requestId,
    },
    buttons: [],
  };
}

function fitText(message: FeishuOutboundMessage, maximumBytes: number): FeishuOutboundMessage {
  let low = 0;
  let high = new TextEncoder().encode(message.text).byteLength;
  let best = { ...message, text: '' };
  while (low <= high) {
    const middle = Math.floor((low + high) / 2);
    const candidate = { ...message, text: truncateUtf8(message.text, middle) };
    if (canonicalJsonBytes(candidate) <= maximumBytes) {
      best = candidate;
      low = middle + 1;
    } else {
      high = middle - 1;
    }
  }
  return best;
}

export function boundFeishuOutboundMessage(
  input: FeishuOutboundMessage,
  maximumBytes: number,
): FeishuOutboundMessage {
  if (canonicalJsonBytes(input) <= maximumBytes) return input;
  let candidate = fitText(input, maximumBytes);
  if (canonicalJsonBytes(candidate) <= maximumBytes) return candidate;
  const hadActions = input.cards.some((card) => card.buttons.length > 0);
  candidate = {
    ...candidate,
    text: hadActions ? READ_ONLY_WARNING : candidate.text,
    cards: input.cards.map((card) =>
      card.buttons.length > 0 ? readOnlyActionCard(card) : minimalNonActionCard(card),
    ),
  };
  if (hadActions) {
    while (canonicalJsonBytes(candidate) > maximumBytes && candidate.cards.length > 0) {
      candidate = { ...candidate, cards: candidate.cards.slice(0, -1) };
    }
    if (canonicalJsonBytes(candidate) <= maximumBytes) return candidate;
    throw new FeishuGatewayError(
      'delivery_too_large',
      'Read-only Feishu approval warning exceeds the delivery bound',
    );
  }
  candidate = fitText(candidate, maximumBytes);
  while (canonicalJsonBytes(candidate) > maximumBytes && candidate.cards.length > 0) {
    candidate = { ...candidate, cards: candidate.cards.slice(0, -1) };
  }
  candidate = fitText(candidate, maximumBytes);
  if (canonicalJsonBytes(candidate) <= maximumBytes) return candidate;
  throw new FeishuGatewayError(
    'delivery_too_large',
    'Minimal Feishu message envelope exceeds the delivery bound',
  );
}
