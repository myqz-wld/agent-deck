import type { JSX } from 'react';
import type { ImageSource } from '@shared/types';
import { ImageBlobLoader } from './diff/renderers/ImageBlobLoader';

const SIZE = {
  xs: 'h-8 w-8',
  sm: 'h-12 w-12',
  md: 'h-24 w-24',
  lg: 'h-40 w-40',
} as const;
type Size = keyof typeof SIZE;

interface Props {
  sessionId: string;
  source: ImageSource;
  size?: Size;
  onClick?: () => void;
  alt?: string;
  className?: string;
}

/**
 * 缩略图组件：用 ImageBlobLoader 加载，按 size 渲染固定方块。
 * 加载中显示脉冲灰底；加载失败显示 reason 文字（如 enoent / denied）。
 *
 * 用于 ActivityFeed 的 ImageRead/Write/Edit 工具卡片右下角，以及任何其他要显示缩略图的位置。
 */
export function ImageThumb({
  sessionId,
  source,
  size = 'sm',
  onClick,
  alt,
  className = '',
}: Props): JSX.Element {
  const baseCls = `${SIZE[size]} rounded border border-deck-border bg-white/[0.02] object-cover ${className}`;
  return (
    <ImageBlobLoader sessionId={sessionId} source={source}>
      {({ loading, result }) => {
        if (loading) {
          return <div className={`${baseCls} animate-pulse`} aria-label="加载中" />;
        }
        if (!result) {
          return <div className={baseCls} />;
        }
        if (!result.ok) {
          return (
            <div
              className={`${baseCls} flex items-center justify-center text-[8px] text-deck-muted`}
              title={`${result.reason}${result.detail ? `: ${result.detail}` : ''}`}
            >
              {result.reason}
            </div>
          );
        }
        return (
          <img
            src={result.dataUrl}
            alt={alt ?? (source.kind === 'path' ? source.path : 'image')}
            onClick={onClick}
            className={`${baseCls} ${onClick ? 'cursor-zoom-in' : ''}`}
          />
        );
      }}
    </ImageBlobLoader>
  );
}
