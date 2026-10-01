import { fromMarkdown } from 'mdast-util-from-markdown';
import type { Definition, Nodes } from 'mdast';
import { FeishuGatewayError } from '@gateways/im';
import { CONTROL_DATA_CHARACTERS } from '@gateways/im/text-policy';

const MAX_POST_BYTES = 29_000;
const TABLE = /(?:^|\n)[^\n]*\|[^\n]*\n[ \t]*\|?[ \t]*:?-{3,}/u;
const STRIKE = /~~\S[^\n]*?\S~~|~~\S~~/u;

function visit(node: Nodes, callback: (node: Nodes) => boolean | void): void {
  if (callback(node) === false) return;
  if ('children' in node) for (const child of node.children) visit(child, callback);
}

function label(node: Nodes): string {
  if ('alt' in node) return node.alt ?? '';
  if ('value' in node) return node.value;
  return 'children' in node ? node.children.map(label).join('') : '';
}

function codeSpan(value: string): string {
  const longest = Math.max(0, ...(value.match(/`+/gu) ?? []).map(run => run.length));
  const fence = '`'.repeat(longest + 1);
  const space = /^[` ]|[` ]$/u.test(value) ? ' ' : '';
  return `${fence}${space}${value}${space}${fence}`;
}

function escapeLabel(value: string): string {
  return value.replace(/([\\`*_[\]<>])/gu, '\\$1');
}

function webLink(value: string): boolean {
  try { return ['http:', 'https:', 'mailto:'].includes(new URL(value).protocol); }
  catch { return false; }
}

function readablePath(value: string): string {
  try {
    const decoded = decodeURIComponent(value);
    return CONTROL_DATA_CHARACTERS.test(decoded) ? value : decoded;
  } catch { return value; }
}

/** Native post(md) renders CommonMark/GFM; parse only to preserve literals and normalize local links. */
export function renderFeishuMessage(text: string): { messageType: 'text' | 'post'; content: string } {
  const root = fromMarkdown(text);
  const definitions = new Map<string, Definition>();
  visit(root, node => {
    if (node.type === 'definition') definitions.set(node.identifier.toUpperCase(), node);
  });
  let formatted = TABLE.test(text) || STRIKE.test(text);
  const changes: Array<{ start: number; end: number; value: string }> = [];
  const replace = (node: Nodes, value: string) => {
    const start = node.position?.start.offset;
    const end = node.position?.end.offset;
    if (start !== undefined && end !== undefined) changes.push({ start, end, value });
  };
  visit(root, node => {
    if (!['root', 'paragraph', 'text', 'definition'].includes(node.type)) formatted = true;
    if (node.type === 'text' && node.position?.start.offset !== undefined && node.position.end.offset !== undefined &&
      text.slice(node.position.start.offset, node.position.end.offset) !== node.value) formatted = true;
    if (node.type === 'html') {
      // Display model-produced tags literally; never turn them into Feishu mentions or media.
      replace(node, node.value.replaceAll('<', '＜').replaceAll('>', '＞'));
      return false;
    }
    if (node.type === 'link' || node.type === 'linkReference' || node.type === 'image' || node.type === 'imageReference') {
      const target = 'url' in node ? node.url : definitions.get(node.identifier.toUpperCase())?.url;
      if (!target) return true;
      const image = node.type === 'image' || node.type === 'imageReference';
      if (image || !webLink(target)) {
        const name = label(node);
        const path = readablePath(target);
        const destination = codeSpan(path);
        replace(node, !name || name === path ? destination : `${escapeLabel(name)}：${destination}`);
        return false;
      }
    }
    return true;
  });
  if (!formatted) return { messageType: 'text', content: JSON.stringify({ text }) };
  let markdown = text;
  for (const change of changes.sort((a, b) => b.start - a.start)) {
    markdown = markdown.slice(0, change.start) + change.value + markdown.slice(change.end);
  }
  const content = JSON.stringify({ zh_cn: { content: [[{ tag: 'md', text: markdown }]] } });
  if (new TextEncoder().encode(content).byteLength > MAX_POST_BYTES) {
    throw new FeishuGatewayError('delivery_too_large', 'Rendered Feishu rich text exceeds provider limits');
  }
  return { messageType: 'post', content };
}
