import type { JSX } from 'react';
import type { DiffPayload } from '@shared/types';

/**
 * PDF diff 渲染器（占位）。
 *
 * 实现指引：
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
      <div className="font-medium text-deck-text">PDF diff（待实现）</div>
      <div className="mt-1">文件：{payload.filePath}</div>
    </div>
  );
}
