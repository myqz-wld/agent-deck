import { Component, lazy, Suspense, useCallback, useEffect, useRef, useState, type JSX, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import log from '@renderer/utils/logger';
import { CloseIcon, RefreshIcon } from '../../icons';
import { StableButtonContent } from '../../StableButtonContent';
import { useModalFocus } from '../../use-modal-focus';

const logger = log.scope('log-viewer');

// Monaco 体积大，仅在日志内容真正显示时加载。
const Editor = lazy(async () => {
  const { configureLocalMonaco } = await import('@renderer/lib/monaco-local');
  configureLocalMonaco();
  const mod = await import('@monaco-editor/react');
  return { default: mod.Editor };
});

/** Monaco chunk 失败只降级当前模态，不能让设置页进入根级崩溃态。 */
class MonacoErrorBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError(): { failed: boolean } {
    return { failed: true };
  }
  componentDidCatch(error: Error): void {
    logger.error('monaco editor lazy load failed', error);
  }
  render(): ReactNode {
    if (this.state.failed) {
      return (
        <div className="flex h-full items-center justify-center p-3 text-center text-[11px] text-status-waiting">
          日志视图加载失败（Monaco 资源未能加载）。请改用「打开日志目录」查看原始文件。
        </div>
      );
    }
    return this.props.children;
  }
}

interface LogReadResult {
  ok: boolean;
  existed: boolean;
  content?: string;
  truncated?: boolean;
  size?: number;
  path?: string;
  error?: string;
}

interface Props {
  open: boolean;
  onClose: () => void;
}

/**
 * 当天日志只读视图。Portal 保证 fixed overlay 不受设置页 backdrop/filter containing block
 * 影响；单调请求序号保证关闭、重开或刷新后，旧响应不能覆盖当前状态。
 */
export function LogViewerModal({ open, onClose }: Props): JSX.Element | null {
  const [result, setResult] = useState<LogReadResult | null>(null);
  const [loading, setLoading] = useState(false);
  const dialogRef = useRef<HTMLDivElement>(null);
  // 防快速开关 / 连点刷新时旧响应回写新状态
  const seqRef = useRef(0);

  const load = useCallback(async (): Promise<void> => {
    const seq = ++seqRef.current;
    setLoading(true);
    try {
      const r = await window.api.logsReadToday();
      if (seq !== seqRef.current) return;
      setResult(r);
    } catch (err) {
      if (seq !== seqRef.current) return;
      setResult({
        ok: false,
        existed: true,
        error: '读取日志失败，请重试。',
      });
    } finally {
      if (seq === seqRef.current) setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!open) {
      // 关闭时失效 in-flight 请求 + 清内容（下次打开重新拉，不残留旧日志）
      ++seqRef.current;
      setResult(null);
      setLoading(false);
      return;
    }
    void load();
    return () => {
      ++seqRef.current;
    };
  }, [open, load]);

  const handleClose = (): void => {
    ++seqRef.current;
    setResult(null);
    setLoading(false);
    onClose();
  };

  useModalFocus({ dialogRef, onClose: handleClose, open });

  if (!open) return null;

  return createPortal(
    <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/60 backdrop-blur-sm">
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="log-viewer-title"
        tabIndex={-1}
        className="no-drag flex h-[80%] w-[min(900px,92vw)] flex-col rounded-xl border border-deck-border bg-deck-bg-strong p-4 shadow-2xl"
      >
        <header className="mb-2 flex items-center justify-between gap-2">
          <div className="flex min-w-0 flex-col gap-0.5">
            <span id="log-viewer-title" className="text-[13px] font-medium text-deck-text">当天日志</span>
            {result?.path && (
              <code className="truncate text-[9px] text-deck-muted/60" title={result.path}>
                {result.path}
              </code>
            )}
          </div>
          <div className="flex shrink-0 gap-1">
            <button
              type="button"
              onClick={() => void load()}
              disabled={loading}
              className="rounded bg-white/8 px-2 py-0.5 text-[10px] text-deck-muted hover:bg-white/15 hover:text-deck-text disabled:opacity-50"
            >
              <StableButtonContent
                activeKey={loading ? 'busy' : 'idle'}
                variants={[
                  { key: 'idle', content: <><RefreshIcon className="mr-1 h-3 w-3" />刷新</> },
                  { key: 'busy', content: '加载中…' },
                ]}
              />
            </button>
            <button
              type="button"
              onClick={handleClose}
              aria-label="关闭日志查看"
              className="flex h-5 w-5 items-center justify-center rounded text-[11px] text-deck-muted hover:bg-white/10"
            >
              <CloseIcon className="h-3.5 w-3.5" />
            </button>
          </div>
        </header>

        {result?.truncated && (
          <div className="mb-2 rounded border border-status-waiting/40 bg-status-waiting/10 px-2 py-1 text-[10px] text-status-waiting">
            日志过大（{result.size != null ? `${(result.size / 1024 / 1024).toFixed(1)}MB` : '> 2MB'}），仅显示最新 2MB 尾部。完整内容请用「打开日志目录」查看。
          </div>
        )}

        <div className="min-h-0 flex-1 overflow-hidden rounded-md border border-deck-border">
          {result && !result.ok ? (
            <div className="p-2 text-[11px] text-status-waiting">
              {result.error ?? '读取失败'}
            </div>
          ) : result && !result.existed ? (
            <div className="flex h-full items-center justify-center text-[11px] text-deck-muted">
              今天还没有日志
            </div>
          ) : result?.content != null ? (
            <MonacoErrorBoundary>
              <Suspense
                fallback={
                  <div className="flex h-full items-center justify-center text-[11px] text-deck-muted">
                    加载日志视图…
                  </div>
                }
              >
                <Editor
                  height="100%"
                  language="plaintext"
                  theme="vs-dark"
                  value={result.content}
                  options={{
                    readOnly: true,
                    minimap: { enabled: false },
                    fontSize: 11,
                    scrollBeyondLastLine: false,
                    automaticLayout: true,
                    wordWrap: 'on',
                    overviewRulerLanes: 0,
                    lineNumbers: 'on',
                  }}
                />
              </Suspense>
            </MonacoErrorBoundary>
          ) : (
            <div className="flex h-full items-center justify-center text-[11px] text-deck-muted">
              读取中…
            </div>
          )}
        </div>
      </div>
    </div>,
    document.body,
  );
}
