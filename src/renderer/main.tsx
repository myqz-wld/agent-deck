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
  console.error('[renderer] window.onerror', ev.error ?? ev.message);
  showFatal(`window.onerror: ${ev.message}\nsrc=${ev.filename}:${ev.lineno}:${ev.colno}`);
});
window.addEventListener('unhandledrejection', (ev) => {
  console.error('[renderer] unhandledrejection', ev.reason);
  showFatal(`unhandledrejection: ${(ev.reason as { message?: string })?.message ?? ev.reason}`);
});

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
  close.onclick = (): void => el.remove();
  el.appendChild(close);

  root.appendChild(el);
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
