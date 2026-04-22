import { useEffect, useState } from 'react';

export type RenderMode = 'plaintext' | 'markdown';

const STORAGE_KEY = 'agent-deck:message-render-mode';
const EVENT_NAME = 'agent-deck:render-mode-changed';

function read(): RenderMode {
  try {
    const v = localStorage.getItem(STORAGE_KEY);
    return v === 'markdown' ? 'markdown' : 'plaintext';
  } catch {
    return 'plaintext';
  }
}

function write(next: RenderMode): void {
  try {
    localStorage.setItem(STORAGE_KEY, next);
    // 同窗口内 storage 事件不触发，需要自定义事件让其它挂载的 hook 实例也同步
    window.dispatchEvent(new CustomEvent(EVENT_NAME));
  } catch {
    /* localStorage 关了就忍着 */
  }
}

/**
 * 全局「消息气泡默认渲染模式」共享 hook。
 *
 * 设计：
 * - localStorage 单值：'plaintext' | 'markdown'，默认 plaintext
 * - 任何一处调 setMode → 写 localStorage + dispatch 自定义事件 →
 *   所有挂载的 MessageBubble 通过本 hook 的 listener 同步刷新
 * - 这意味着「单条切换 = 全局切换」，所有 bubble 一起改样式；
 *   不引入「单条独立持久化」状态，避免按 message id 存 map 的复杂度
 *
 * 多窗口（理论上桌面 app 单窗口，但留后路）：
 * - 同浏览器上下文不同 window.localStorage 共享时，'storage' 事件会触发
 * - 同窗口内多个 hook 实例共享：靠自定义事件 EVENT_NAME
 */
export function useGlobalRenderMode(): [RenderMode, (next: RenderMode) => void] {
  const [mode, setMode] = useState<RenderMode>(read);

  useEffect(() => {
    const sync = (): void => setMode(read());
    window.addEventListener(EVENT_NAME, sync);
    window.addEventListener('storage', sync);
    return () => {
      window.removeEventListener(EVENT_NAME, sync);
      window.removeEventListener('storage', sync);
    };
  }, []);

  return [mode, write];
}
