// Plan runtime-logging-electron-log-20260529 §D5 + §D8 + §Step 3.0.4: 第一行 import
// logger.ts, 让 Object.assign(console, log.functions) 守门生效 — renderer 端 console.*
// 经 IPC bridge 落进同一份 main-YYYY-MM-DD.log。logger.ts §不变量 8 仅依赖 electron-log/
// renderer + vite env, 不依赖业务模块, 安全可顶部第一行。
import log from './utils/logger';

import React from 'react';
import ReactDOM from 'react-dom/client';
import { App } from './App';
import { createCloseIconElement } from './components/icons/dom';
import './styles/globals.css';

const logger = log.scope('renderer-main');

function hasAgentDeckPreloadBridge(
  value: unknown,
): value is Window['api'] {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as Partial<Window['api']>;
  return (
    typeof candidate.onSessionUpserted === 'function' &&
    typeof candidate.listSessions === 'function' &&
    typeof candidate.getSettings === 'function'
  );
}

function PreloadBridgeUnavailable(): React.JSX.Element {
  return (
    <div
      role="alert"
      style={{
        position: 'absolute',
        inset: 0,
        display: 'grid',
        placeContent: 'center',
        gap: 10,
        padding: 24,
        color: 'rgb(255, 170, 120)',
        background: 'rgba(20, 20, 24, 0.94)',
        fontFamily: 'system-ui, sans-serif',
        fontSize: 13,
        textAlign: 'center',
      }}
    >
      <strong>Agent Deck 桌面桥接未加载</strong>
      <span>
        当前页面没有 Electron preload API。请在 Agent Deck 桌面窗口中打开；若已在桌面窗口，
        可重新加载当前界面恢复，现有主进程和会话不会被终止。
      </span>
      <button
        type="button"
        onClick={() => window.location.reload()}
        style={{
          justifySelf: 'center',
          padding: '6px 12px',
          color: 'inherit',
          background: 'transparent',
          border: '1px solid currentColor',
          borderRadius: 6,
          cursor: 'pointer',
        }}
      >
        重新加载界面
      </button>
    </div>
  );
}

interface RendererErrorDetails {
  name: string;
  message: string;
  stack?: string;
}

type RendererDiagnosticValue =
  | null
  | boolean
  | number
  | string
  | RendererDiagnosticValue[]
  | { [key: string]: RendererDiagnosticValue };

interface RendererDiagnosticLimits {
  maxString: number;
  maxDepth: number;
  maxKeys: number;
  maxArray: number;
}

// The renderer TypeScript project deliberately cannot import main-process modules. Keep this
// renderer transport facade aligned with the canonical serializer in main/utils/safe-diagnostic:
// main sanitizes persisted/terminal output again, while this copy protects DevTools before IPC.
function safeRendererString(value: string, maxLength = 512): string {
  const redacted = value
    .replace(
      /\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]+/gi,
      '$1 [REDACTED]',
    )
    .replace(
      /\b(auth|authentication|authorization|proxy-authorization|credential|cookie|set-cookie|api[_-]?key|access[_-]?token|refresh[_-]?token|id[_-]?token|password|passwd|secret|client[_-]?secret)\b(\s*[:=]\s*)(?:"[^"]*"|'[^']*'|[^\s,;}\]]+)/gi,
      '$1$2[REDACTED]',
    )
    .replace(
      /\b(?:sk|rk|pk|ghp|github_pat|xox[baprs])[-_][A-Za-z0-9_-]{8,}\b/gi,
      '[REDACTED]',
    )
    .replace(
      /(?:file:\/\/)?\/(?:Users|home)\/[^/\s"'`),;\]}]+(?:\/[^\s"'`),;\]}]*)?/g,
      '<home-path>',
    )
    .replace(
      /[A-Za-z]:\\Users\\[^\\\s"'`),;\]}]+(?:\\[^\s"'`),;\]}]*)?/g,
      '<home-path>',
    )
    .replace(
      /(?:file:\/\/)?\/(?:private\/tmp|tmp|var\/tmp|private\/var\/folders|var\/folders)(?:\/[^\s"'`),;\]}]*)?/g,
      '<temp-path>',
    )
    .replace(
      /(?:file:\/\/)?\/(?:workspace|workspaces|repo|Volumes)(?:\/[^\s"'`),;\]}]*)?/g,
      '<local-path>',
    )
    .replace(
      /[A-Za-z]:\\(?!Users\\)[^\\\s"'`),;\]}]+(?:\\[^\s"'`),;\]}]*)?/g,
      '<local-path>',
    );
  return redacted.length <= maxLength
    ? redacted
    : `${redacted.slice(0, maxLength)}…[truncated:${redacted.length - maxLength}]`;
}

function safeRendererErrorDetails(value: unknown): RendererErrorDetails {
  let isError = false;
  try {
    isError = value instanceof Error;
  } catch {
    return { name: 'Error', message: 'Non-Error rejection (uninspectable)' };
  }
  if (isError) {
    const error = value as Error;
    let name = 'Error';
    let message = 'Unknown error';
    let stack: string | undefined;
    try {
      name = error.name || name;
      message = error.message || message;
      stack = error.stack;
    } catch {
      return { name: 'Error', message: 'Uninspectable Error' };
    }
    return {
      name: safeRendererString(name, 80),
      message: safeRendererString(message),
      ...(stack ? { stack: safeRendererString(stack, 2_048) } : {}),
    };
  }
  if (typeof value === 'string') {
    return { name: 'Error', message: safeRendererString(value) };
  }
  const type = value === null ? 'null' : Array.isArray(value) ? 'array' : typeof value;
  return { name: 'Error', message: `Non-Error rejection (${type})` };
}

function safeRendererDisplayText(value: string): string {
  return safeRendererString(value, 3_072);
}

function rendererRedactedKey(key: string): boolean {
  const normalized = key.toLowerCase().replace(/[^a-z0-9]/g, '');
  return /(?:authorization|authentication|credential|password|passwd|cookie|secret|privatekey|signingkey|apikey|accesskey|cardnumber|creditcard|cvv|ssn|prompt|input|payload|rawresult|rawresponse|rawoutput|providertext)$/.test(
    normalized,
  ) || /token$/.test(normalized) || normalized === 'auth';
}

function safeRendererDiagnostic(
  value: unknown,
  limits: RendererDiagnosticLimits,
  seen: WeakSet<object>,
  depth = 0,
): RendererDiagnosticValue {
  if (value === null) return null;
  if (typeof value === 'string') return safeRendererString(value, limits.maxString);
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') return Number.isFinite(value) ? value : String(value);
  if (typeof value === 'bigint') return `${value.toString()}n`;
  if (typeof value === 'undefined') return '[undefined]';
  if (typeof value === 'symbol' || typeof value === 'function') {
    return `[${typeof value}]`;
  }
  if (depth >= limits.maxDepth) return '[MaxDepth]';
  if (value instanceof Error) {
    return safeRendererErrorDetails(value) as unknown as RendererDiagnosticValue;
  }
  if (seen.has(value as object)) return '[Circular]';
  seen.add(value as object);
  if (Array.isArray(value)) {
    const selected = value.slice(0, limits.maxArray).map(
      (item) => safeRendererDiagnostic(item, limits, seen, depth + 1),
    );
    if (value.length > selected.length) {
      selected.push(`[TruncatedItems:${value.length - selected.length}]`);
    }
    return selected;
  }
  const output: Record<string, RendererDiagnosticValue> = {};
  const keys = Object.keys(value as object);
  for (const key of keys.slice(0, limits.maxKeys)) {
    const safeKey = safeRendererString(key, 80);
    if (rendererRedactedKey(key)) {
      output[safeKey] = '[REDACTED]';
      continue;
    }
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (descriptor && !('value' in descriptor)) {
      output[safeKey] = '[Accessor]';
      continue;
    }
    output[safeKey] = safeRendererDiagnostic(
      (value as Record<string, unknown>)[key],
      limits,
      seen,
      depth + 1,
    );
  }
  if (keys.length > limits.maxKeys) {
    output.__truncatedKeys = keys.length - limits.maxKeys;
  }
  return output;
}

const rendererDiagnosticHook = (
  message: { data: unknown[]; [key: string]: unknown },
  _transport: unknown,
  transportName?: string,
): { data: unknown[]; [key: string]: unknown } => {
  const limits: RendererDiagnosticLimits =
    transportName === 'console' && import.meta.env.MODE === 'development'
      ? { maxString: 2_048, maxDepth: 5, maxKeys: 40, maxArray: 20 }
      : { maxString: 512, maxDepth: 4, maxKeys: 24, maxArray: 12 };
  try {
    return {
      ...message,
      data: message.data.map(
        (item) => safeRendererDiagnostic(item, limits, new WeakSet<object>()),
      ),
    };
  } catch {
    return { ...message, data: ['[DiagnosticSerializationFailed]'] };
  }
};

(log.hooks as unknown as (typeof rendererDiagnosticHook)[]).push(rendererDiagnosticHook);

class RootErrorBoundary extends React.Component<
  { children: React.ReactNode },
  { error: Error | null }
> {
  state = { error: null as Error | null };
  static getDerivedStateFromError(error: Error): { error: Error } {
    return { error };
  }
  componentDidCatch(error: Error, info: React.ErrorInfo): void {
    const details = safeRendererErrorDetails(error);
    logger.error(
      '[renderer] uncaught render error',
      details,
      { componentStack: safeRendererString(info.componentStack ?? '', 2_048) },
    );
  }
  render(): React.ReactNode {
    if (!this.state.error) return this.props.children;
    const details = safeRendererErrorDetails(this.state.error);
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
          界面崩溃：{details.name}：{details.message}
        </div>
        <pre style={{ whiteSpace: 'pre-wrap', opacity: 0.8 }}>{details.stack}</pre>
      </div>
    );
  }
}

// 顶层异常兜底：脚本/资源加载失败时也能在窗口里看到错误，不必依赖 DevTools
window.addEventListener('error', (ev) => {
  // 资源加载失败（img/script/link 的 onerror 也会冒泡到 window）：只 console，不遮 UI
  if (ev.target && ev.target !== window) {
    logger.error('[renderer] resource load error', {
      tagName: (ev.target as HTMLElement).tagName,
      eventType: ev.type,
    });
    return;
  }
  // 跨源脚本错误：浏览器出于 CORS 只给空壳 "Script error." src=:0:0，
  // 既无定位也无 stack，弹 UI 只会遮挡正常内容；记到 console 留痕即可。
  if (ev.message === 'Script error.' && !ev.error && !ev.filename) {
    logger.warn('[renderer] cross-origin script error (suppressed)');
    return;
  }
  if (typeof ev.message === 'string' && isMonacoUnmountRaceNoise(ev.message)) {
    logger.debug(
      '[renderer] monaco unmount race (suppressed):',
      safeRendererString(ev.message),
    );
    return;
  }
  const details = safeRendererErrorDetails(ev.error ?? ev.message);
  logger.error('[renderer] window.onerror', details);
  showFatal(
    `界面错误：${details.name}：${details.message}\n` +
    `位置：${safeRendererDisplayText(`${ev.filename}:${ev.lineno}:${ev.colno}`)}`,
  );
});
window.addEventListener('unhandledrejection', (ev) => {
  // 跟 window.onerror 同套白名单 —— monaco DiffEditor 卸载 race 抛错有两条路径：
  // 1. 同步 throw（被 ErrorBoundary / window.onerror 接住，比如 'TextModel got disposed ...'）
  // 2. async throw 变 promise rejection（比如 diffProviderFactoryService.js:110 在 await
  //    editorWorkerService.computeDiff 之后判 !c 抛 'no diff result available' —— 切会话 /
  //    关 diff 时 model 提前 dispose 触发 race）
  // 两条都不影响功能，是 monaco 内部清理时序问题，console 留痕即可。不过滤会全屏遮挡用户。
  if (isMonacoUnmountRaceNoise(ev.reason)) {
    logger.debug(
      '[renderer] monaco unmount race (suppressed):',
      safeRendererErrorDetails(ev.reason),
    );
    return;
  }
  const details = safeRendererErrorDetails(ev.reason);
  logger.error('[renderer] unhandledrejection', details);
  showFatal(`异步操作失败：${details.name}：${details.message}`);
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
 * 用户必须点关闭按钮才能恢复。改成 8s 自动 fade，手动关闭仍然立刻关；console 留痕不丢线索。 */
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
  el.textContent = safeRendererDisplayText(text);

  const close = document.createElement('button');
  close.type = 'button';
  close.setAttribute('aria-label', '关闭错误提示');
  close.title = '关闭';
  close.append(createCloseIconElement());
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
  showFatal('界面启动失败：找不到 #root 节点');
} else {
  try {
    ReactDOM.createRoot(container).render(
      <React.StrictMode>
        {hasAgentDeckPreloadBridge(window.api) ? (
          <RootErrorBoundary>
            <App />
          </RootErrorBoundary>
        ) : (
          <PreloadBridgeUnavailable />
        )}
      </React.StrictMode>,
    );
  } catch (err) {
    const details = safeRendererErrorDetails(err);
    showFatal(
      `界面启动失败：${details.name}：${details.message}\n${details.stack ?? ''}`,
    );
  }
}
