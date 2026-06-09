/**
 * Codex input 包装 / 解包模块（R37 P2-E Step 3.4a）。
 *
 * 抽自 ClaudeSdkBridge → CodexSdkBridge index.ts 顶部的两个 module-level helper：
 *   - `packCodexInput(text, attachments)` — createSession + sendMessage 入口共用
 *   - `extractAttachmentPaths(input)` — closeSession 清理孤儿 attachment 文件
 *
 * 与 claude sdk-bridge `send-validation.ts` / `model-resolve.ts` 等 sub-module 同模式：
 * 无 class state，纯函数 + 严格类型签名，可独立 unit test（虽然当前 codex sdk-bridge 没
 * test 覆盖，留给后续 review 补）。
 */
import type { UploadedAttachmentRef } from '@shared/types';
import type { CodexAppServerUserInput } from '../app-server/client';

export type CodexUserInput =
  | { type: 'local_image'; path: string }
  | { type: 'text'; text: string };

export type CodexInput = string | CodexUserInput[];

/**
 * 把 (text, attachments) 包成 Codex runtime 接受的 input 形态。
 *
 * - 纯文本：直接返回 string（与原行为字节级一致）
 * - 带 attachments：返回 CodexUserInput[]，按 [local_image, ..., text] 顺序
 *   （与 Claude SDK image-block-first 顺序对齐，让 LLM 先看到图再读问题）
 *
 * Codex `local_image` 只接 path，不接 base64：path 已由 IPC 层 writeUploadedImage
 * 落盘到 <userData>/image-uploads/<uuid>.<ext>，codex 子进程自己 fs 读。
 */
export function packCodexInput(text: string, attachments?: UploadedAttachmentRef[]): CodexInput {
  if (!attachments || attachments.length === 0) return text;
  const items: CodexUserInput[] = [];
  for (const ref of attachments) {
    items.push({ type: 'local_image', path: ref.path });
  }
  if (text.length > 0) {
    items.push({ type: 'text', text });
  }
  return items;
}

/**
 * 从 Codex input 中提取 attachments path 集合（用于 closeSession 时清理 unused 文件）。
 *
 * 仅扫 CodexUserInput[] 形态；string 形态直接返回 []。
 */
export function extractAttachmentPaths(input: CodexInput): string[] {
  if (typeof input === 'string') return [];
  const paths: string[] = [];
  for (const item of input) {
    if (item.type === 'local_image' && typeof item.path === 'string') {
      paths.push(item.path);
    }
  }
  return paths;
}

export function toCodexAppServerInput(input: CodexInput): CodexAppServerUserInput[] {
  if (typeof input === 'string') {
    return [{ type: 'text', text: input, text_elements: [] }];
  }

  const out: CodexAppServerUserInput[] = [];
  for (const item of input) {
    if (item.type === 'local_image') {
      out.push({ type: 'localImage', path: item.path });
    } else if (item.type === 'text') {
      out.push({ type: 'text', text: item.text, text_elements: [] });
    }
  }
  return out;
}
