import type { DiffPayload } from '@shared/types';

/**
 * 把 toolInput 翻译成 DiffPayload，让 PermissionRow / ToolStartRow 渲染 Monaco/图片 diff。
 * 与 toolInput 中字段约定耦合，新增工具支持时在这里加一条；返回 null 时上层退化为 JSON 展开。
 */
export function toolInputToDiff(
  toolName: string,
  input: unknown,
): DiffPayload<string | null> | null {
  if (!input || typeof input !== 'object') return null;
  const i = input as {
    file_path?: string;
    old_string?: string;
    new_string?: string;
    content?: string;
    edits?: { old_string: string; new_string: string }[];
  };
  if (!i.file_path) return null;
  const ts = Date.now();
  if (toolName === 'Edit' && typeof i.old_string === 'string' && typeof i.new_string === 'string') {
    return { kind: 'text', filePath: i.file_path, before: i.old_string, after: i.new_string, ts };
  }
  if (toolName === 'Write' && typeof i.content === 'string') {
    return { kind: 'text', filePath: i.file_path, before: null, after: i.content, ts };
  }
  if (toolName === 'MultiEdit' && Array.isArray(i.edits) && i.edits.length > 0) {
    return {
      kind: 'text',
      filePath: i.file_path,
      before: i.edits.map((e) => e.old_string).join('\n---\n'),
      after: i.edits.map((e) => e.new_string).join('\n---\n'),
      metadata: { source: 'MultiEdit', editCount: i.edits.length },
      ts,
    };
  }
  return null;
}
