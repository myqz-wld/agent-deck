import { createHash } from 'node:crypto';
import { FeishuGatewayError, boundedJsonText, truncateUtf8 } from '@gateways/im';
import type { FeishuOutboundMessage, FeishuPendingAction, FeishuPendingCard } from '@gateways/im';
import {
  FEISHU_ACTION_PROTOCOL,
  type FeishuCardActionEnvelope,
  type FeishuQuestionFieldBinding,
} from './action-envelope';
import type { FeishuPresentationActionSigner } from './nonce';

const UTF8 = new TextEncoder();
const MAX_FEISHU_CARD_BYTES = 29_000;

function elementId(prefix: string, ...values: Array<string | number>): string {
  const digest = createHash('sha256').update(values.join('\u001f')).digest('hex').slice(0, 14);
  return `${prefix}_${digest}`;
}

function safeMarkdown(value: string): string {
  return value
    .replaceAll('<', '‹')
    .replaceAll('>', '›')
    .replaceAll('[', '［')
    .replaceAll(']', '］')
    .replaceAll('`', 'ˋ');
}

function presentationExpiry(card: FeishuPendingCard): number | null {
  if (card.presentationLifetimeMs === 0) return null;
  if (
    !Number.isSafeInteger(card.presentedAt) ||
    card.presentedAt < 0 ||
    !Number.isSafeInteger(card.presentationLifetimeMs) ||
    card.presentationLifetimeMs < 0
  ) throw new FeishuGatewayError('invalid_core_response', 'Pending card lifetime is malformed');
  return Math.min(Number.MAX_SAFE_INTEGER, card.presentedAt + card.presentationLifetimeMs);
}

function actionWithoutValue(action: FeishuPendingAction): Omit<FeishuPendingAction, 'value'> {
  if (action.value !== undefined) {
    throw new FeishuGatewayError('invalid_core_response', 'Issued pending card action carries a value');
  }
  const { value: _ignored, ...bound } = action;
  return bound;
}

function questionIds(card: FeishuPendingCard): readonly string[] {
  const ids = card.display.questionIds;
  if (
    Array.isArray(ids) &&
    ids.length > 0 &&
    ids.length <= 32 &&
    ids.every((id) => typeof id === 'string' && id.length > 0)
  ) return ids as string[];
  return ['answer'];
}

function fieldBindings(card: FeishuPendingCard): readonly FeishuQuestionFieldBinding[] {
  return questionIds(card).map((questionId, index) => ({
    providerKey: elementId('q', card.requestId, index, questionId),
    questionId,
  }));
}

function envelope(
  action: FeishuPendingAction,
  expiresAt: number | null,
  signer: FeishuPresentationActionSigner,
  fields?: readonly FeishuQuestionFieldBinding[],
): FeishuCardActionEnvelope {
  const bound = actionWithoutValue(action);
  return {
    protocol: FEISHU_ACTION_PROTOCOL,
    action: { ...bound, nonce: signer.signPresentation(bound, expiresAt) },
    expiresAt,
    ...(fields ? { fields } : {}),
  };
}

function button(
  card: FeishuPendingCard,
  index: number,
  buttonIndex: number,
  signer: FeishuPresentationActionSigner,
): Record<string, unknown> {
  const item = card.buttons[buttonIndex];
  return {
    tag: 'button',
    element_id: elementId('a', card.requestId, index, buttonIndex),
    text: { tag: 'plain_text', content: truncateUtf8(item.label, 80) },
    type: item.action.action === 'approve' || item.action.action === 'accept' ? 'primary' : 'default',
    width: 'default',
    size: 'medium',
    behaviors: [{
      type: 'callback',
      value: envelope(item.action, presentationExpiry(card), signer),
    }],
  };
}

function form(
  card: FeishuPendingCard,
  cardIndex: number,
  buttonIndex: number,
  signer: FeishuPresentationActionSigner,
): Record<string, unknown> {
  const item = card.buttons[buttonIndex];
  const fields = fieldBindings(card);
  return {
    tag: 'form',
    name: elementId('f', card.requestId, cardIndex),
    elements: [
      ...fields.map((field) => ({
        tag: 'input',
        element_id: field.providerKey,
        name: field.providerKey,
        required: true,
        input_type: 'multiline_text',
        max_length: 1_000,
        placeholder: { tag: 'plain_text', content: '请输入回答' },
        label: { tag: 'plain_text', content: truncateUtf8(field.questionId, 100) },
      })),
      {
        tag: 'button',
        element_id: elementId('s', card.requestId, cardIndex),
        name: elementId('n', card.requestId, cardIndex),
        text: { tag: 'plain_text', content: truncateUtf8(item.label, 80) },
        type: 'primary',
        action_type: 'form_submit',
        behaviors: [{
          type: 'callback',
          value: envelope(item.action, presentationExpiry(card), signer, fields),
        }],
      },
    ],
  };
}

function cardElements(
  message: FeishuOutboundMessage,
  signer: FeishuPresentationActionSigner,
): Record<string, unknown>[] {
  const elements: Record<string, unknown>[] = [
    { tag: 'markdown', content: safeMarkdown(message.text) },
  ];
  for (const [cardIndex, card] of message.cards.entries()) {
    const detail = boundedJsonText(card.display, 4_096);
    elements.push({
      tag: 'markdown',
      content: safeMarkdown(`**${card.title}** · ${card.state}\n${detail}`),
    });
    for (const [buttonIndex, item] of card.buttons.entries()) {
      elements.push(
        item.action.action === 'submit'
          ? form(card, cardIndex, buttonIndex, signer)
          : button(card, cardIndex, buttonIndex, signer),
      );
    }
  }
  return elements;
}

export function renderFeishuCard(
  message: FeishuOutboundMessage,
  signer: FeishuPresentationActionSigner,
): string {
  const title = message.kind === 'notification'
    ? 'Agent Deck notification'
    : message.kind === 'card-update'
      ? 'Agent Deck update'
      : 'Agent Deck';
  const card = {
    schema: '2.0',
    config: {
      update_multi: true,
      summary: { content: truncateUtf8(message.text, 256) },
    },
    header: {
      title: { tag: 'plain_text', content: title },
      template: message.kind === 'card-update' ? 'green' : 'blue',
    },
    body: { elements: cardElements(message, signer) },
  };
  const serialized = JSON.stringify(card);
  if (UTF8.encode(serialized).byteLength > MAX_FEISHU_CARD_BYTES) {
    throw new FeishuGatewayError('delivery_too_large', 'Rendered Feishu card exceeds provider limits');
  }
  return serialized;
}

export function renderFeishuText(message: FeishuOutboundMessage): string {
  return JSON.stringify({ text: message.text });
}
