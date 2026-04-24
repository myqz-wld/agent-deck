import React from 'react';
import ReactDOM from 'react-dom/client';
import { App } from './App';
import './styles/globals.css';

class RootErrorBoundary extends React.Component<
  { children: React.ReactNode },
  { error: Error | null }
> {
  state = { error: null as Error | null };
  static getDerivedStateFromError(error: Error): { error: Error } {
    return { error };
  }
  componentDidCatch(error: Error, info: React.ErrorInfo): void {
    console.error('[renderer] uncaught render error', error, info);
  }
  render(): React.ReactNode {
    if (!this.state.error) return this.props.children;
    const e = this.state.error;
    return (
      <div
        style={{
          position: 'absolute',
          inset: 0,
          padding: '12px',
          fontFamily: 'monospace',
          fontSize: '11px',
          color: 'rgb(255, 120, 120)',
          background: 'rgba(20, 20, 24, 0.85)',
          overflow: 'auto',
        }}
      >
        <div style={{ marginBottom: 6, fontWeight: 600 }}>
          Renderer crashed: {e.name}: {e.message}
        </div>
        <pre style={{ whiteSpace: 'pre-wrap', opacity: 0.8 }}>{e.stack}</pre>
      </div>
    );
  }
}

// 顶层异常兜底：脚本/资源加载失败时也能在窗口里看到错误，不必依赖 DevTools
window.addEventListener('error', (ev) => {
  // 资源加载失败（img/script/link 的 onerror 也会冒泡到 window）：只 console，不遮 UI
  if (ev.target && ev.target !== window) {
    console.error('[renderer] resource load error', (ev.target as HTMLElement).tagName, ev);
    return;
  }
  // 跨源脚本错误：浏览器出于 CORS 只给空壳 "Script error." src=:0:0，
  // 既无定位也无 stack，弹 UI 只会遮挡正常内容；记到 console 留痕即可。
  if (ev.message === 'Script error.' && !ev.error && !ev.filename) {
    console.warn('[renderer] cross-origin script error (suppressed)');
    return;
  }
  if (typeof ev.message === 'string' && isMonacoUnmountRaceNoise(ev.message)) {
    console.warn('[renderer] monaco unmount race (suppressed):', ev.message);
    return;
  }
  console.error('[renderer] window.onerror', ev.error ?? ev.message);
  showFatal(`window.onerror: ${ev.message}\nsrc=${ev.filename}:${ev.lineno}:${ev.colno}`);
});
window.addEventListener('unhandledrejection', (ev) => {
  // 跟 window.onerror 同套白名单 —— monaco DiffEditor 卸载 race 抛错有两条路径：
  // 1. 同步 throw（被 ErrorBoundary / window.onerror 接住，比如 'TextModel got disposed ...'）
  // 2. async throw 变 promise rejection（比如 diffProviderFactoryService.js:110 在 await
  //    editorWorkerService.computeDiff 之后判 !c 抛 'no diff result available' —— 切会话 /
  //    关 diff 时 model 提前 dispose 触发 race）
  // 两条都不影响功能，是 monaco 内部清理时序问题，console 留痕即可。不过滤会全屏遮挡用户。
  if (isMonacoUnmountRaceNoise(ev.reason)) {
    console.warn(
      '[renderer] monaco unmount race (suppressed):',
      (ev.reason as { message?: string })?.message ?? ev.reason,
    );
    return;
  }
  console.error('[renderer] unhandledrejection', ev.reason);
  showFatal(`unhandledrejection: ${(ev.reason as { message?: string })?.message ?? ev.reason}`);
});

/**
 * monaco DiffEditor 卸载 race 的已知 noise 模式集合：
 * - 'TextModel got disposed before DiffEditorWidget'：DiffEditor cleanup 顺序倒置（同步抛）
 * - 'no diff result available'：editorWorkerService 在 model dispose 后返回 null，
 *   `if (!c) throw new Error(...)` 走 async 路径 → unhandledrejection
 * - monaco cancellation：worker 任务取消时 monaco 抛 name='Canceled' && message='Canceled'
 *   的 Error（见 monaco-editor errors.js: canceled() / CancellationError）。切会话 / 关 diff
 *   时 worker 任务被取消属于正常行为。判定逻辑直接对齐 monaco 自身 isCancellationError，
 *   不只看 message 防止误吞「Job was Canceled by user」这类 message 含 Canceled 的真错。
 *   REVIEW_2 修。
 * 都是 @monaco-editor/react 卸载 / 切换 model 期间的内部 race，不影响功能。
 */
function isMonacoUnmountRaceNoise(reason: unknown): boolean {
  const r = reason as { name?: string; message?: string } | null | undefined;
  if (r?.name === 'Canceled' && r?.message === 'Canceled') return true;
  const msg =
    typeof reason === 'string'
      ? reason
      : (reason as { message?: string })?.message ?? String(reason ?? '');
  return /TextModel got disposed before DiffEditorWidget|no diff result available/.test(msg);
}

/** 自动消失的 fatal banner 持续时间。
 * 之前所有未捕获 rejection 都升级到全屏 fatal 永久遮挡，瞬时主进程异常会把整窗打死，
 * 用户必须点 ✕ 才能恢复。改成 8s 自动 fade，手动 ✕ 仍然立刻关；console 留痕不丢线索。 */
const FATAL_AUTO_DISMISS_MS = 8000;

function showFatal(text: string): void {
  const root = document.getElementById('root');
  if (!root) return;
  if (root.querySelector('[data-fatal]')) return;
  const el = document.createElement('pre');
  el.dataset.fatal = '1';
  Object.assign(el.style, {
    position: 'absolute',
    inset: '0',
    padding: '12px',
    margin: '0',
    fontFamily: 'monospace',
    fontSize: '11px',
    color: 'rgb(255, 120, 120)',
    background: 'rgba(20, 20, 24, 0.85)',
    overflow: 'auto',
    whiteSpace: 'pre-wrap',
    zIndex: '999',
    transition: 'opacity 400ms ease',
  });
  el.textContent = text;

  const close = document.createElement('button');
  close.textContent = '✕';
  Object.assign(close.style, {
    position: 'absolute',
    top: '6px',
    right: '8px',
    background: 'transparent',
    color: 'rgb(255, 120, 120)',
    border: '1px solid rgba(255, 120, 120, 0.4)',
    borderRadius: '4px',
    cursor: 'pointer',
    padding: '0 6px',
    fontSize: '11px',
  });
  // 自动消失 + 手动关都走同一段 cleanup，避免 timer 残留
  let timer: ReturnType<typeof setTimeout> | null = null;
  const remove = (): void => {
    if (timer != null) {
      clearTimeout(timer);
      timer = null;
    }
    el.style.opacity = '0';
    setTimeout(() => el.remove(), 400);
  };
  close.onclick = remove;
  el.appendChild(close);

  root.appendChild(el);
  // REVIEW_2：瞬时异常不再永久遮挡，给固定时长用户能看到错误也能恢复 UI。
  timer = setTimeout(remove, FATAL_AUTO_DISMISS_MS);
}

const container = document.getElementById('root');
if (!container) {
  showFatal('#root not found in DOM');
} else {
  try {
    ReactDOM.createRoot(container).render(
      <React.StrictMode>
        <RootErrorBoundary>
          <App />
        </RootErrorBoundary>
      </React.StrictMode>,
    );
  } catch (err) {
    showFatal(`createRoot failed: ${(err as Error).message}\n${(err as Error).stack ?? ''}`);
  }
}
