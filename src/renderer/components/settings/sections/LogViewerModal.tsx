import { Component, lazy, Suspense, useCallback, useEffect, useRef, useState, type JSX, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import log from '@renderer/utils/logger';

const logger = log.scope('log-viewer');

// Monaco 体积大，懒加载（与 diff/renderers/TextDiffRenderer.tsx 同款 lazy import 模式，
// 但这里用单文件 Editor 而非 DiffEditor）。
const Editor = lazy(async () => {
  const mod = await import('@monaco-editor/react');
  return { default: mod.Editor };
});

/**
 * Monaco lazy import 专用 local ErrorBoundary（REVIEW simple-review log+asset [MED reviewer-claude] 修法）。
 *
 * **为何需要**：`<Suspense>` 只接 pending promise，**不接 rejection**（React 语义）。dynamic
 * import('@monaco-editor/react') 失败（chunk 404 / hash 对不上 / 网络）时 lazy 组件 render 期
 * re-throw → 无 local boundary 时冒泡到 main.tsx 唯一的 RootErrorBoundary → 整 app 渲染持久
 * 「Renderer crashed」全屏崩溃屏（无 auto-dismiss，须 remount 才恢复）。一个日志查看小功能的
 * chunk 失败不应打死整 app。本 boundary 把失败收敛成模态内 localized 提示，引导用户改用
 * 「打开日志目录」。（sibling TextDiffRenderer 当前无 local boundary，是既有 tradeoff，本次不一并改。）
 */
class MonacoErrorBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError(): { failed: boolean } {
    return { failed: true };
  }
  // REVIEW (simple-review log+asset) [LOW reviewer-claude] 修法：补 componentDidCatch 落 logger。
  // 没有它则 lazy import reject 被本 boundary 抢先接住后静默吞掉（改前是冒泡到 main.tsx
  // RootErrorBoundary.componentDidCatch 落 logger.error）→ Monaco chunk 真失败（stale deploy /
  // hash 对不上，项目打包踩坑有先例）时开发侧日志查无线索。getDerivedStateFromError 已够触发
  // fallback render，componentDidCatch 仅补可观测性（正交）。
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
 * 应用内日志查看 modal（替代原「在 Finder 中显示」外部跳转）。
 *
 * - 通过 `window.api.logsReadToday()` 读当天 main-YYYY-MM-DD.log，用只读 Monaco Editor 展示。
 * - **定位**：根 div 用 `fixed inset-0 z-[60]` 全屏覆盖 + `createPortal` 到 `document.body`。
 *   两点缺一不可，否则 modal 不可见（本 bug 曾误判为「被裁切」/「打包没生效」）：
 *   1. **根 div 不能叠 `.frosted-frame`**：globals.css 的 `.frosted-frame{position:relative}` 是
 *      **unlayered**，Tailwind 的 `.fixed{position:fixed}` 在 `@layer utilities` 内。CSS 级联中
 *      unlayered 永远胜 layered（早于 specificity / 源码顺序），故同元素叠 `frosted-frame fixed`
 *      时 position 实为 `relative`、`fixed` 被静默顶掉 → 退回文档流被设置面板 overflow 裁成一条；
 *      改 portal 后又被排到占满视口的 #root 之后、`body{overflow:hidden}` 挤出视口 → 完全不可见。
 *      frosted-frame 是窗口玻璃面板用的，overlay 只需 `bg-black/60 backdrop-blur-sm` 遮罩。
 *   2. **必须 `createPortal` 到 body**：祖先链里 FloatingFrame(.frosted-frame) 与 SettingsDialog
 *      外层 `backdrop-blur-sm` 的 backdrop-filter 会把后代 `fixed` 的 containing block 从 viewport
 *      改成该祖先（CSS 规范，同 transform / filter）。portal 脱离整条祖先链，fixed 才相对 viewport。
 *   z-[60] 高于 SettingsDialog(z-40) 与 ContentViewerModal(z-50)。
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

  return createPortal(
    <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/60 backdrop-blur-sm">
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
