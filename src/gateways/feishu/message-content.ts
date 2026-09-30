import { FeishuGatewayError } from '@gateways/im/errors';
import { FORBIDDEN_TEXT_CHARACTERS } from '@gateways/im/text-policy';

function invalid(): never {
  throw new FeishuGatewayError('invalid_event', 'Feishu message content is malformed');
}

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return invalid();
  return value as Record<string, unknown>;
}

function text(value: unknown): string {
  if (typeof value !== 'string' || FORBIDDEN_TEXT_CHARACTERS.test(value)) return invalid();
  return value;
}

function nodeText(value: unknown): string {
  const node = object(value);
  switch (node.tag) {
    // Feishu's receive schema flattens quotes and lists into text nodes in content.
    case 'text': case 'md': return text(node.text);
    case 'a': {
      const label = text(node.text);
      const href = text(node.href);
      return label === href || !label ? href : `${label} (${href})`;
    }
    case 'at': {
      const id = text(node.user_id);
      if (!/^@_user_[0-9]+$|^all$/.test(id)) return invalid();
      // Only the mapper may strip a prefix, using the authenticated mention identity.
      return `${id === 'all' ? '@_all' : id} `;
    }
    case 'code_block': return `\n\`\`\`\n${text(node.text)}\n\`\`\`\n`;
    case 'hr': return '\n---\n';
    case 'emotion': return `[表情：${text(node.emoji_type)}]`;
    case 'img': return '[图片未读取]';
    case 'media': return '[视频未读取]';
    default: throw new FeishuGatewayError('unknown_command', 'Unsupported Feishu rich text node');
  }
}

/** Receive-post shape, not the locale-wrapped sending schema. Never fetch quoted/attached resources. */
export function feishuMessageText(type: 'text' | 'post', serialized: string): string {
  let parsed: unknown;
  try { parsed = JSON.parse(serialized); } catch { return invalid(); }
  const content = object(parsed);
  let result: string;
  if (type === 'text') {
    if (Object.keys(content).some(key => key !== 'text')) {
      throw new FeishuGatewayError('unknown_field', 'Unknown Feishu text content field');
    }
    result = text(content.text);
  } else {
    if (Object.keys(content).some(key => !['title', 'content', 'content_v2'].includes(key))) {
      throw new FeishuGatewayError('unknown_field', 'Unknown Feishu post content field');
    }
    // content preserves command text and authenticated mention placeholders, whereas content_v2
    // may embed Markdown/HTML mentions. Use v2 only if the plain receive projection is absent.
    const rows = content.content ?? content.content_v2;
    if (!Array.isArray(rows) || rows.length > 256) return invalid();
    let nodes = 0;
    const lines = rows.map(row => {
      if (!Array.isArray(row) || (nodes += row.length) > 1_024) return invalid();
      return row.map(nodeText).join('');
    });
    const title = content.title === undefined ? '' : text(content.title);
    result = [...(title ? [title] : []), ...lines].join('\n');
  }
  if (!result.trim() || new TextEncoder().encode(result).byteLength > 16_384) return invalid();
  return result;
}
