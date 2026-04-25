import type { JSX, ReactNode } from 'react';

interface Props {
  children: ReactNode;
  /** true 时容器切换为「极透明 + 弱模糊」样式，便于看穿到下方应用。
   *  由 App.tsx 算 (pinned && transparentWhenPinned) 传入：物理 pin 不等于视觉透明态，
   *  用户在设置里关掉「pin 时透明」后 pin 状态不应再触发透明 CSS（CHANGELOG_30）。 */
  transparent?: boolean;
}

/**
 * 半透明毛玻璃容器。所有按钮（pin/折叠/设置）由 App header 统一管理，
 * 这里不再叠浮动按钮，避免与 header 区域重叠。
 *
 * 模糊由 macOS vibrancy（主进程已开 under-window）+ CSS backdrop-filter 双重提供。
 */
export function FloatingFrame({ children, transparent }: Props): JSX.Element {
  return (
    <div
      className="frosted-frame relative h-full w-full overflow-hidden rounded-2xl border border-deck-border"
      data-transparent={transparent ? 'true' : 'false'}
    >
      {children}
    </div>
  );
}
