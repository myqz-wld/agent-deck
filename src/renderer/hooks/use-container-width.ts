import { useEffect, useRef, useState, type RefObject } from 'react';

/**
 * 观测某个元素的宽度（plan model-token-stats-and-dashboard-20260602 §Phase 3 R0）。
 *
 * 需求3：header Top3 token/s 区在窗口/容器宽度不足时退化隐藏。项目此前无任何 ResizeObserver /
 * matchMedia 响应式机制，本 hook 从零引入容器宽度感知。
 *
 * 用法：
 * ```ts
 * const ref = useRef<HTMLDivElement>(null);
 * const width = useContainerWidth(ref);
 * // width === null 表示尚未测量（首帧）；测量后是 contentRect.width（px，不含 padding/border 外缘）
 * ```
 *
 * - 卸载时 disconnect observer（不泄漏）。
 * - ResizeObserver 不可用（极老 webview，Electron 不会发生）时 width 保持 null，caller 应把
 *   null 视为「未知宽度」按显示处理（宁可显示也不误隐藏）。
 */
export function useContainerWidth<T extends HTMLElement>(ref: RefObject<T | null>): number | null {
  const [width, setWidth] = useState<number | null>(null);
  // observer 实例 ref，避免 effect 重跑时重复创建
  const observerRef = useRef<ResizeObserver | null>(null);

  useEffect(() => {
    const el = ref.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver((entries) => {
      for (const entry of entries) {
        setWidth(entry.contentRect.width);
      }
    });
    observer.observe(el);
    observerRef.current = observer;
    // 立即同步一次初始宽度（ResizeObserver 首帧也会 fire，但显式取一次避免首帧 null 抖动）
    setWidth(el.getBoundingClientRect().width);
    return () => {
      observer.disconnect();
      observerRef.current = null;
    };
  }, [ref]);

  return width;
}
