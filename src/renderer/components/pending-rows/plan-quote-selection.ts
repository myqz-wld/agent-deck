import { IS_DARWIN } from '@renderer/lib/platform';

export const PLAN_QUOTE_SHORTCUT = IS_DARWIN ? '⌘ + Enter' : 'Ctrl + Enter';
export const PLAN_QUOTE_ARIA_SHORTCUT = IS_DARWIN ? 'Meta+Enter' : 'Control+Enter';

export function isPlanQuoteShortcut(event: {
  key: string;
  metaKey: boolean;
  ctrlKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
}): boolean {
  return event.key === 'Enter' &&
    !event.altKey &&
    !event.shiftKey &&
    (IS_DARWIN ? event.metaKey && !event.ctrlKey : event.ctrlKey && !event.metaKey);
}

export function quotedPlanText(text: string): string {
  return text
    .split('\n')
    .map((line) => `> ${line}`)
    .join('\n');
}

export function selectedTextWithin(root: HTMLDivElement | null): string {
  const selection = window.getSelection();
  if (!selection || selection.rangeCount === 0 || selection.isCollapsed || !root) return '';
  const range = selection.getRangeAt(0);
  if (!root.contains(range.startContainer) || !root.contains(range.endContainer)) return '';
  return selection.toString().trim().slice(0, 8_000);
}
