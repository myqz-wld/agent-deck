import { lazy, Suspense, useCallback, useEffect, useRef, useState, type JSX } from 'react';

// Monaco 体积大，懒加载（与 diff/renderers/TextDiffRenderer.tsx 同款 lazy import 模式，
// 但这里用单文件 Editor 而非 DiffEditor）。
const Editor = lazy(async () => {
  const mod = await import('@monaco-editor/react');
  return { default: mod.Editor };
});

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
 * 应用内日志查看 modal（替代原「在 Finder 中显示」外部跳转）。
 *
 * - 通过 `window.api.logsReadToday()` 读当天 main-YYYY-MM-DD.log，用只读 Monaco Editor 展示。
 * - **定位**：`fixed inset-0 z-[60]` —— 必须 `fixed` 而非 `absolute`：LogsSection 嵌在
 *   SettingsDialog 的 `overflow-y-auto max-h-[85%]` 卡片内，`absolute` 会被该 overflow 裁掉且
 *   定位到错误祖先；`fixed` 逃逸 overflow + 豁免 `.frosted-frame > *:not(.fixed)` 强制 relative
 *   规则（globals.css）。z-[60] 高于 SettingsDialog(z-40) 与 ContentViewerModal(z-50)。
 * - 刷新按钮重新拉取（日志是滚动写入的，查看期间可能有新行）。
 * - 空态（existed:false）/ 截断 banner（truncated:true，main 端 > 2MB 只返尾部 2MB）。
 */
export function LogViewerModal({ open, onClose }: Props): JSX.Element | null {
  const [result, setResult] = useState<LogReadResult | null>(null);
  const [loading, setLoading] = useState(false);
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
        error: `读取日志失败：${(err as Error).message ?? String(err)}`,
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
  }, [open, load]);

  if (!open) return null;

  return (
    <div className="frosted-frame fixed inset-0 z-[60] flex items-center justify-center bg-black/60 backdrop-blur-sm">
      <div className="no-drag flex h-[80%] w-[80%] max-w-[900px] flex-col rounded-xl border border-deck-border bg-deck-bg-strong p-4 shadow-2xl">
        <header className="mb-2 flex items-center justify-between gap-2">
          <div className="flex min-w-0 flex-col gap-0.5">
            <span className="text-[13px] font-medium text-deck-text">当天日志</span>
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
              {loading ? '加载中…' : '刷新'}
            </button>
            <button
              type="button"
              onClick={onClose}
              aria-label="关闭日志查看"
              className="flex h-5 w-5 items-center justify-center rounded text-[11px] text-deck-muted hover:bg-white/10"
            >
              ✕
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
          ) : (
            <div className="flex h-full items-center justify-center text-[11px] text-deck-muted">
              读取中…
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
