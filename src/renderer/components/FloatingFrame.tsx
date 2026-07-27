import type { JSX, ReactNode } from 'react';

interface Props {
  children: ReactNode;
  /** true 时容器切换为仅保留 alpha 底色的极透明样式，便于看穿到下方应用。
   *  Phase 5 Step 5.6（plan mcp-bug-and-feature-batch-20260513）解耦后由 App.tsx 直接传
   *  windowTransparent 单字段（不再 && pinned），透明独立于 pin 状态切换。 */
  transparent?: boolean;
}

/**
 * 半透明毛玻璃容器。所有按钮（pin/折叠/设置）由 App header 统一管理，
 * 这里不再叠浮动按钮，避免与 header 区域重叠。
 *
 * 非透明态的模糊由 macOS vibrancy（主进程已开 under-window）+ CSS backdrop-filter 提供。
 * 透明态两者都关闭，只保留 alpha 背景让 WindowServer 直接合成；不要在透明 NSWindow 上恢复
 * 全窗 backdrop-filter，否则滚动层会再次落入独立 filter render pass 并产生持久残影。
 */
export function FloatingFrame({ children, transparent }: Props): JSX.Element {
  return (
    <div
      id="floating-frame-root"
      className="frosted-frame relative h-full w-full overflow-hidden rounded-2xl border border-deck-border"
      data-transparent={transparent ? 'true' : 'false'}
    >
      {children}
    </div>
  );
}
