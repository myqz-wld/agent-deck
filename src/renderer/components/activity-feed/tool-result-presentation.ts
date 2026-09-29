import { resolveToolNameAlias } from './describe';
import { formatToolInput, formatToolResult } from './format';

export interface ToolOutputSection {
  label?: string;
  text: string;
  isError?: boolean;
}

export interface ToolResultPresentation {
  sections: ToolOutputSection[];
  /** Only interpreted structures need an additional raw disclosure. */
  raw?: unknown;
}

export function presentToolResult(value: unknown, toolName = ''): ToolResultPresentation {
  const tool = resolveToolNameAlias(toolName);
  const record = objectRecord(value);
  if (record && tool === 'Read') {
    const file = objectRecord(record.file);
    const content = file?.content ?? record.content;
    if (typeof content === 'string') return interpreted(value, [{ text: content }]);
  }
  if (record && tool === 'Bash' &&
      (typeof record.stdout === 'string' || typeof record.stderr === 'string')) {
    const sections: ToolOutputSection[] = [];
    if (typeof record.stdout === 'string') sections.push({ label: '标准输出', text: record.stdout });
    if (typeof record.stderr === 'string') sections.push({ label: '标准错误', text: record.stderr, isError: true });
    return interpreted(value, sections);
  }
  const blocks = Array.isArray(value) ? value : Array.isArray(record?.content) ? record.content : null;
  if (blocks) {
    const sections = nonempty(blocks.flatMap((block): ToolOutputSection[] => {
      const content = objectRecord(block);
      if (content?.type === 'text' && typeof content.text === 'string') return [{ text: content.text }];
      // Images have a separate preview below the tool output. Keep their original data available.
      if (content?.type === 'image') return [];
      return [{ text: formatToolResult(block) }];
    }));
    if (sections.length === 0 && record?.structuredContent != null) {
      sections.push({ text: formatToolInput(record.structuredContent) });
    }
    return interpreted(value, sections);
  }
  if (record?.type === 'image') return interpreted(value, []);
  const content = objectRecord(record?.content);
  if (record?.type === 'content' && content?.type === 'image') return interpreted(value, []);
  if (record?.type === 'text' && typeof record.text === 'string') {
    return interpreted(value, [{ text: record.text }]);
  }
  return { sections: nonempty([{ text: formatToolResult(value) }]) };
}

export function rawToolResult(value: unknown): string {
  return formatToolInput(value);
}

function interpreted(raw: unknown, sections: ToolOutputSection[]): ToolResultPresentation {
  return { sections: nonempty(sections), raw };
}

function nonempty(sections: ToolOutputSection[]): ToolOutputSection[] {
  return sections.filter(({ text }) => text.trim().length > 0);
}

function objectRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown> : null;
}
