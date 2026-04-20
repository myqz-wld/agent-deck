import type { JSX, ReactNode } from 'react';

interface Props {
  children: ReactNode;
  pinned?: boolean;
}

/**
 * 半透明毛玻璃容器。所有按钮（pin/折叠/设置）由 App header 统一管理，
 * 这里不再叠浮动按钮，避免与 header 区域重叠。
 *
 * 模糊由 macOS vibrancy（主进程已开 under-window）+ CSS backdrop-filter 双重提供。
 * pinned=true 时切换为更通透的样式，便于在窗口下方继续工作。
 */
export function FloatingFrame({ children, pinned }: Props): JSX.Element {
  return (
    <div
      className="frosted-frame relative h-full w-full overflow-hidden rounded-2xl border border-deck-border"
      data-pinned={pinned ? 'true' : 'false'}
    >
      {children}
    </div>
  );
}
