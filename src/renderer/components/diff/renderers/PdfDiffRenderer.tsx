import type { JSX } from 'react';
import type { DiffPayload } from '@shared/types';

/**
 * PDF diff 渲染器（占位，暂未实现）。
 *
 * 注册理由：DiffViewer 在没有命中 plugin 时也会渲染一段灰底文字，注册一个明确「暂不支持」
 * 的 renderer 让用户能直接看到原因 + 文件路径，而不是一个通用「无可用 renderer」误导。
 *
 * 实现指引（未来接入时参考）：
 * - before/after 为 PDF 路径或 ArrayBuffer
 * - 可用 pdf.js 解析为分页图片，再调用 ImageDiffRenderer
 * - 或对每页提取文字，用 TextDiffRenderer 展示
 */
interface Props {
  payload: DiffPayload<unknown>;
}

export function PdfDiffRenderer({ payload }: Props): JSX.Element {
  return (
    <div className="rounded-md border border-dashed border-deck-border px-3 py-4 text-[11px] text-deck-muted">
      <div className="font-medium text-deck-text">PDF diff 暂不支持</div>
      <div className="mt-1">文件：{payload.filePath}</div>
      <div className="mt-1 text-[10px] text-deck-muted/80">
        agent-deck 还未接入 PDF diff 渲染。改动已记录在 file_changes 表里，未来支持后会自动展示。
      </div>
    </div>
  );
}
