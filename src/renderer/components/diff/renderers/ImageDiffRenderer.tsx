import type { JSX } from 'react';
import type { DiffPayload } from '@shared/types';

/**
 * 图片 diff 渲染器（占位）。
 *
 * 实现指引：
 * - before / after 应为图片 URL 或 base64 data URI
 * - 推荐用「滑动对比」(react-compare-slider) 或左右并排
 * - metadata 可携带 mime / 分辨率信息
 */
interface Props {
  payload: DiffPayload<string | null>;
}

export function ImageDiffRenderer({ payload }: Props): JSX.Element {
  return (
    <div className="rounded-md border border-dashed border-deck-border px-3 py-4 text-[11px] text-deck-muted">
      <div className="font-medium text-deck-text">图片 diff（待实现）</div>
      <div className="mt-1">文件：{payload.filePath}</div>
      <div className="mt-1 text-[10px] opacity-70">
        kind: {payload.kind}；before/after 应为图片 URL 或 data URI
      </div>
    </div>
  );
}
