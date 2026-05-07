import { useCallback, useEffect, useRef, useState, type JSX } from 'react';
import type { AssetKind, AssetMeta, BundledAssetsSnapshot, UserAssetsSnapshot } from '@shared/types';
import { AssetEditor } from './assets/AssetEditor';
import { ClaudeMdEditor } from './settings/ClaudeMdEditor';

/**
 * 资产库 Dialog（CHANGELOG_57 C1+C3+C4；CHANGELOG_58 把 CLAUDE.md 编辑器从 SettingsDialog
 * 整体迁过来，作为「应用约定」tab 的常驻内容；设置面板只剩注入 toggle + 跳本 dialog 的链接）。
 * Header「📚 资产库」按钮入口。
 *
 * 三 Tab：
 * - Skills：内置（agent-deck plugin，只读 + 「查看完整内容」）+ 用户自定义
 *   （~/.claude/skills/，可编辑/删除/新建/Finder reveal）
 * - Agents：同上结构（agents 有 model + tools 字段）
 * - 应用约定：内嵌 ClaudeMdEditor 直接编辑（保存 / 撤销 / 恢复默认 / dirty 拦截，跟设置版同款）
 *
 * 子 modal（state 切换内嵌渲染，不另开文件）：
 * - ContentViewer：查看任意资产（内置或用户）的完整 md 文本，只读
 * - AssetEditor：用户自定义资产编辑（新建 / 编辑 / 删除）
 *
 * dirty 拦截契约（从 SettingsDialog 迁过来，套路相同）：
 * - ClaudeMdEditor 通过 `onDirtyChange` 上报草稿；ref 持有避免父级重渲染
 * - X 关闭 / 切走 claude-md tab 前调 `confirmDiscardClaudeMd` 二次确认
 * - `onClaudeMdDirtyChange` 用 useCallback 稳定 identity，否则 child useEffect cleanup→run
 *   会在 parent rerender 时误触发伪 false（REVIEW_4 M11 教训）
 */

interface Props {
  open: boolean;
  onClose: () => void;
}

type TabKey = 'skills' | 'agents' | 'claude-md';

interface ViewerState {
  asset: AssetMeta;
  content: string | null;
  error: string | null;
}

interface EditorState {
  kind: AssetKind;
  asset: AssetMeta | null;
}

export function AssetsLibraryDialog({ open, onClose }: Props): JSX.Element | null {
  const [tab, setTab] = useState<TabKey>('skills');
  const [bundled, setBundled] = useState<BundledAssetsSnapshot | null>(null);
  const [user, setUser] = useState<UserAssetsSnapshot | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [viewer, setViewer] = useState<ViewerState | null>(null);
  const [editor, setEditor] = useState<EditorState | null>(null);

  /** Mount fetch / refreshUser 用此 seq 比对，老响应回写到本地 state 时 abort
   *  （CHANGELOG_57 R1·F7：Promise.allSettled 无 cleanup，open→close→open 快切 + refreshUser 慢响应
   *  覆盖刚保存的 user 列表）。每次 open=true 自增；cleanup 不需要单独写——seq 是 lifeline。 */
  const fetchSeqRef = useRef(0);
  /** Viewer fetch 的 seq guard（CHANGELOG_57 R1·F5：闭包捕获 stale asset 导致 A 慢响应覆盖 B 视图） */
  const viewerSeqRef = useRef(0);
  /** ClaudeMdEditor 草稿 dirty 标记（由子组件回报）；用 ref 持有避免本 dialog rerender 抖动。 */
  const claudeMdDirtyRef = useRef(false);
  /** 关闭 / 切 tab 二次确认的并发锁，防多次点击弹多个 confirm（REVIEW_4 LOW 同款）。 */
  const closeInFlightRef = useRef(false);

  /** REVIEW_4 M11：父级用 useCallback 稳定 identity，防 child useEffect cleanup→run
   *  在 parent rerender 时误触发伪 false，让 dirty 标记瞬间为 false。 */
  const onClaudeMdDirtyChange = useCallback((d: boolean) => {
    claudeMdDirtyRef.current = d;
  }, []);

  useEffect(() => {
    if (!open) {
      // CHANGELOG_57 R1·F6：关闭 dialog 时主动 reset 子 modal state，避免重开瞬间显示残留
      setViewer(null);
      setEditor(null);
      return;
    }
    const seq = ++fetchSeqRef.current;
    void Promise.allSettled([
      window.api.listBundledAssets(),
      window.api.listUserAssets(),
    ]).then(([b, u]) => {
      if (seq !== fetchSeqRef.current) return; // 老 open 的迟到响应：丢
      const errs: string[] = [];
      if (b.status === 'fulfilled') setBundled(b.value);
      else errs.push(`内置资产读取失败：${(b.reason as Error).message}`);
      if (u.status === 'fulfilled') setUser(u.value);
      else errs.push(`用户资产读取失败：${(u.reason as Error).message}`);
      setLoadError(errs.length > 0 ? errs.join('\n') : null);
    });
  }, [open]);

  /**
   * AssetEditor 保存后回拉用户列表。共用 fetchSeqRef，避免「保存→关闭→重开」期间慢响应回写
   * 旧 user 列表覆盖刚保存的（CHANGELOG_57 R1·F7）。
   */
  const refreshUser = (): void => {
    const seq = ++fetchSeqRef.current;
    void window.api.listUserAssets().then((u) => {
      if (seq !== fetchSeqRef.current) return;
      setUser(u);
    });
  };

  /**
   * 打开 viewer：seq guard 防 closure 捕获 stale asset。用户先点 A 后点 B 时，
   * 即使 A 的 fetch 比 B 慢，也只接受当前最新 seq 的响应（CHANGELOG_57 R1·F5）。
   */
  const openViewer = (asset: AssetMeta): void => {
    const seq = ++viewerSeqRef.current;
    setViewer({ asset, content: null, error: null });
    void window.api.getAssetContent(asset.kind, asset.name, asset.source).then((r) => {
      if (seq !== viewerSeqRef.current) return;
      if (r.ok) setViewer({ asset, content: r.content, error: null });
      else setViewer({ asset, content: null, error: r.reason ?? '未知错误' });
    });
  };

  /**
   * X 关闭 / 切走 claude-md tab 共用的 dirty 二次确认。
   * 用户选「丢弃」（true）才让上层执行；用户选「继续编辑」或并发被锁掉返回 false。
   */
  const confirmDiscardClaudeMd = async (kind: 'close' | 'switch'): Promise<boolean> => {
    if (closeInFlightRef.current) return false;
    if (!claudeMdDirtyRef.current) return true;
    closeInFlightRef.current = true;
    try {
      return await window.api.confirmDialog({
        title: kind === 'close' ? '关闭资产库' : '切换标签',
        message: 'CLAUDE.md 有未保存的草稿，确定要丢弃吗？',
        detail: kind === 'close' ? '关闭后改动将丢失，无法恢复。' : '切换后改动将丢失，无法恢复。',
        okLabel: kind === 'close' ? '丢弃并关闭' : '丢弃并切换',
        cancelLabel: '继续编辑',
        destructive: true,
      });
    } finally {
      closeInFlightRef.current = false;
    }
  };

  const guardedClose = async (): Promise<void> => {
    if (await confirmDiscardClaudeMd('close')) onClose();
  };

  /**
   * 切换 tab 时，只在「离开 claude-md」时拦截（其他 tab 之间切换无 dirty 风险）。
   * 切换后 ClaudeMdTab 会 unmount → ClaudeMdEditor cleanup 自动把 ref 回 false。
   */
  const guardedSwitchTab = async (next: TabKey): Promise<void> => {
    if (next === tab) return;
    if (tab !== 'claude-md') {
      setTab(next);
      return;
    }
    if (await confirmDiscardClaudeMd('switch')) setTab(next);
  };

  if (!open) return null;

  return (
    <div className="absolute inset-0 z-40 flex items-center justify-center bg-black/40 backdrop-blur-sm">
      <div className="no-drag w-[420px] max-h-[85%] flex flex-col rounded-xl border border-deck-border bg-deck-bg-strong p-4 shadow-2xl">
        <header className="mb-3 flex items-center justify-between">
          <div className="flex items-center gap-1">
            <h2 className="text-[13px] font-medium">📚 资产库</h2>
            <span className="text-[10px] text-deck-muted/70">（内置 + 用户自定义 agents/skills/CLAUDE.md）</span>
          </div>
          <button
            type="button"
            onClick={() => void guardedClose()}
            aria-label="关闭资产库"
            className="flex h-5 w-5 items-center justify-center rounded text-[11px] text-deck-muted hover:bg-white/10"
          >
            ✕
          </button>
        </header>

        <nav className="mb-3 flex gap-1 border-b border-deck-border/60 pb-2 text-[11px]">
          <TabBtn active={tab === 'skills'} onClick={() => void guardedSwitchTab('skills')}>Skills</TabBtn>
          <TabBtn active={tab === 'agents'} onClick={() => void guardedSwitchTab('agents')}>Agents</TabBtn>
          <TabBtn active={tab === 'claude-md'} onClick={() => void guardedSwitchTab('claude-md')}>应用约定</TabBtn>
        </nav>

        {loadError && (
          <div className="mb-3 rounded border border-status-waiting/40 bg-status-waiting/10 p-2 text-[11px] text-status-waiting whitespace-pre-wrap">
            {loadError}
          </div>
        )}

        <div className="flex-1 overflow-y-auto scrollbar-deck pr-1">
          {tab === 'skills' && (
            <AssetsTab
              kind="skill"
              bundled={bundled?.skills ?? []}
              user={user?.skills ?? []}
              onView={openViewer}
              onEdit={(asset) => setEditor({ kind: 'skill', asset })}
              onNew={() => setEditor({ kind: 'skill', asset: null })}
            />
          )}
          {tab === 'agents' && (
            <AssetsTab
              kind="agent"
              bundled={bundled?.agents ?? []}
              user={user?.agents ?? []}
              onView={openViewer}
              onEdit={(asset) => setEditor({ kind: 'agent', asset })}
              onNew={() => setEditor({ kind: 'agent', asset: null })}
            />
          )}
          {tab === 'claude-md' && <ClaudeMdTab onDirtyChange={onClaudeMdDirtyChange} />}
        </div>
      </div>

      {viewer && (
        <ContentViewerModal
          state={viewer}
          onReveal={() =>
            void window.api.revealAssetInFolder(viewer.asset.kind, viewer.asset.name, viewer.asset.source)
          }
          onClose={() => setViewer(null)}
        />
      )}
      {editor && (
        <AssetEditor
          kind={editor.kind}
          asset={editor.asset}
          onClose={() => setEditor(null)}
          onSaved={refreshUser}
        />
      )}
    </div>
  );
}

function TabBtn({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}): JSX.Element {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`rounded px-2 py-0.5 text-[11px] transition ${
        active ? 'bg-white/10 text-deck-text' : 'text-deck-muted hover:bg-white/5 hover:text-deck-text/85'
      }`}
    >
      {children}
    </button>
  );
}

function AssetsTab({
  kind,
  bundled,
  user,
  onView,
  onEdit,
  onNew,
}: {
  kind: AssetKind;
  bundled: AssetMeta[];
  user: AssetMeta[];
  onView: (asset: AssetMeta) => void;
  onEdit: (asset: AssetMeta) => void;
  onNew: () => void;
}): JSX.Element {
  return (
    <div className="flex flex-col gap-3">
      <section>
        <div className="mb-1 text-[10px] uppercase tracking-wider text-deck-muted/70">
          内置（agent-deck plugin，只读）
        </div>
        {bundled.length === 0 ? (
          <div className="text-[10px] text-deck-muted/60">（无）</div>
        ) : (
          <div className="flex flex-col gap-1.5">
            {bundled.map((a) => (
              <AssetCard key={a.qualifiedName} asset={a} onView={onView} />
            ))}
          </div>
        )}
      </section>

      <section>
        <div className="mb-1 flex items-center justify-between">
          <div className="text-[10px] uppercase tracking-wider text-deck-muted/70">
            用户自定义（~/.claude/{kind === 'agent' ? 'agents' : 'skills'}/）
          </div>
          <button
            type="button"
            onClick={onNew}
            className="rounded bg-status-working/15 px-2 py-0.5 text-[10px] text-status-working hover:bg-status-working/25"
          >
            + 新建{kind === 'agent' ? ' Agent' : ' Skill'}
          </button>
        </div>
        {user.length === 0 ? (
          <div className="text-[10px] text-deck-muted/60">
            暂无；点右上「新建」可创建第一个用户自定义{kind === 'agent' ? ' agent' : ' skill'}（落盘到 ~/.claude/{kind === 'agent' ? 'agents/' : 'skills/'}）
          </div>
        ) : (
          <div className="flex flex-col gap-1.5">
            {user.map((a) => (
              <AssetCard key={a.qualifiedName} asset={a} onView={onView} onEdit={onEdit} />
            ))}
          </div>
        )}
      </section>
    </div>
  );
}

function AssetCard({
  asset,
  onView,
  onEdit,
}: {
  asset: AssetMeta;
  onView: (asset: AssetMeta) => void;
  onEdit?: (asset: AssetMeta) => void;
}): JSX.Element {
  return (
    <div className="rounded-md border border-deck-border bg-white/[0.03] p-2">
      <div className="flex items-start justify-between gap-2">
        <code className="text-[11px] font-medium text-deck-text">{asset.qualifiedName}</code>
        <div className="flex shrink-0 gap-1 no-drag">
          <button
            type="button"
            onClick={() => onView(asset)}
            title="查看完整内容"
            className="rounded bg-white/8 px-1.5 py-0.5 text-[10px] text-deck-muted hover:bg-white/15 hover:text-deck-text"
          >
            查看
          </button>
          {onEdit && (
            <button
              type="button"
              onClick={() => onEdit(asset)}
              title="编辑（删除入口在编辑器内）"
              className="rounded bg-white/8 px-1.5 py-0.5 text-[10px] text-deck-muted hover:bg-white/15 hover:text-deck-text"
            >
              编辑
            </button>
          )}
        </div>
      </div>
      {asset.kind === 'agent' && (asset.model || asset.tools) && (
        <div className="mt-0.5 text-[10px] text-deck-muted/70">
          {asset.model && <span>model: <code className="rounded bg-white/5 px-1">{asset.model}</code> </span>}
          {asset.tools && <span>tools: <code className="rounded bg-white/5 px-1">{asset.tools}</code></span>}
        </div>
      )}
      {asset.description && (
        <div className="mt-1 text-[10px] leading-relaxed text-deck-muted line-clamp-3">
          {asset.description}
        </div>
      )}
      {asset.triggers && asset.triggers.length > 0 && (
        <div className="mt-1 flex flex-wrap gap-1">
          {asset.triggers.map((t) => (
            <code key={t} className="rounded bg-white/5 px-1 text-[10px] text-deck-muted/80">{t}</code>
          ))}
        </div>
      )}
    </div>
  );
}

/**
 * 「应用约定」tab：直接内嵌 ClaudeMdEditor。编辑器自己 fetch 当前生效内容（用户副本优先 →
 * 回落内置）+ 自带 dirty / 保存 / 撤销 / 恢复默认；本 tab 只额外加一行说明，强调与
 * user/project/local CLAUDE.md 互不影响（避免和 Claude Code 自带 memory 文件混淆）。
 */
function ClaudeMdTab({
  onDirtyChange,
}: {
  onDirtyChange: (dirty: boolean) => void;
}): JSX.Element {
  return (
    <div className="flex flex-col gap-2">
      <div className="text-[10px] leading-snug text-deck-muted/70">
        应用内置 CLAUDE.md，独立于 user / project / local CLAUDE.md，
        拼到每个 SDK 会话 system prompt 末尾。改动只对「下次新建会话」生效。
      </div>
      <ClaudeMdEditor onDirtyChange={onDirtyChange} />
    </div>
  );
}

function ContentViewerModal({
  state,
  onReveal,
  onClose,
}: {
  state: ViewerState;
  onReveal: () => void;
  onClose: () => void;
}): JSX.Element {
  return (
    <div className="absolute inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm">
      <div className="no-drag flex h-[80%] w-[420px] flex-col rounded-xl border border-deck-border bg-deck-bg-strong p-4 shadow-2xl">
        <header className="mb-2 flex items-start justify-between gap-2">
          <div className="flex flex-col gap-0.5 min-w-0">
            <code className="text-[11px] font-medium text-deck-text truncate">{state.asset.qualifiedName}</code>
            <code className="text-[9px] text-deck-muted/60 truncate" title={state.asset.absPath}>
              {state.asset.absPath}
            </code>
          </div>
          <div className="flex shrink-0 gap-1">
            <button
              type="button"
              onClick={onReveal}
              title="在 Finder / 资源管理器中显示"
              className="rounded bg-white/8 px-2 py-0.5 text-[10px] text-deck-muted hover:bg-white/15 hover:text-deck-text"
            >
              显示文件
            </button>
            <button
              type="button"
              onClick={onClose}
              aria-label="关闭"
              className="flex h-5 w-5 items-center justify-center rounded text-[11px] text-deck-muted hover:bg-white/10"
            >
              ✕
            </button>
          </div>
        </header>

        {state.error ? (
          <div className="rounded border border-status-waiting/40 bg-status-waiting/10 p-2 text-[11px] text-status-waiting">
            {state.error}
          </div>
        ) : state.content === null ? (
          <div className="text-[11px] text-deck-muted">读取中…</div>
        ) : (
          <pre
            className="flex-1 overflow-y-auto scrollbar-deck whitespace-pre-wrap rounded border border-deck-border bg-white/[0.04] p-2 font-mono text-[10px] leading-relaxed text-deck-text"
            style={{ fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace' }}
          >
            {state.content}
          </pre>
        )}
      </div>
    </div>
  );
}
