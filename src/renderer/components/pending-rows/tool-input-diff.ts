import type { DiffPayload, ImageSource } from '@shared/types';
import { isImageTool } from '@shared/mcp-tools';

/**
 * 把 toolInput 翻译成 DiffPayload，让 PermissionRow / ToolStartRow 渲染 Monaco/图片 diff。
 * 与 toolInput 中字段约定耦合，新增工具支持时在这里加一条；返回 null 时上层退化为 JSON 展开。
 */
export function toolInputToDiff(
  toolName: string,
  input: unknown,
): DiffPayload<string | null> | DiffPayload<ImageSource | null> | null {
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
  // mcp 图片工具：tool-use-start 阶段只有 input.file_path，结构如下：
  // - ImageRead 直接展示这张图（before=null, after=path）→ 驱动 ImageDiffRenderer 缩略图视图
  // - 其他图片工具（Write/Edit/MultiEdit）的 before/after 要等 tool_result 才能拿到 server 快照路径，
  //   tool-use-start 阶段返 null 让 ToolStartRow 不画 diff，等 file-changed 事件来画
  if (isImageTool(toolName)) {
    if (toolName.endsWith('__ImageRead')) {
      return {
        kind: 'image',
        filePath: i.file_path,
        before: null,
        after: { kind: 'path', path: i.file_path },
        metadata: { source: 'ImageRead' },
        ts,
      } as DiffPayload<ImageSource | null>;
    }
    return null;
  }
  return null;
}
