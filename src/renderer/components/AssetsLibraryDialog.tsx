import { useCallback, useEffect, useRef, useState, type JSX } from 'react';
import { DEFAULT_SETTINGS, type AppSettings, type AssetKind, type AssetMeta, type BundledAssetsSnapshot, type UserAssetsSnapshot } from '@shared/types';
import { AssetCard, dedupBundledByName, type NonEmptyAssetGroup } from './assets/AssetCard';
import { AssetEditor } from './assets/AssetEditor';
import { ContentViewerModal, type ContentViewerState } from './assets/ContentViewerModal';
import { InjectionToggleBar } from './assets/InjectionToggleBar';
import { ClaudeMdEditor } from './settings/ClaudeMdEditor';
import { CodexAgentsMdEditor } from './settings/CodexAgentsMdEditor';

/**
 * 资产库 Dialog（CHANGELOG_57 C1+C3+C4；CHANGELOG_58 把 CLAUDE.md 编辑器从 SettingsDialog
 * 整体迁过来；CHANGELOG_69 把 5 个资产注入 toggle 也从 SettingsDialog 三 section 整体迁来，
 * 实现「资产编辑 + 注入开关」单一真源）。Header「📚 资产库」按钮入口。
 *
 * 三 Tab：
 * - Skills：顶部「注入开关」横条（claude plugin + codex skills）+ 内置（agent-deck plugin，
 *   只读 + 「查看完整内容」）+ 用户自定义（~/.claude/skills/，可编辑/删除/新建/Finder reveal）
 * - Agents：顶部「注入开关」横条（claude plugin，与 Skills tab 同一开关）+ 同上结构
 * - 应用约定：顶部「注入开关」横条（claude system prompt + codex AGENTS.md）+ ClaudeMdEditor
 *
 * 子 modal（state 切换内嵌渲染，不另开文件）：
 * - ContentViewer：查看任意资产（内置或用户）的完整 md 文本，只读
 * - AssetEditor：用户自定义资产编辑（新建 / 编辑 / 删除）
 *
 * settings 状态自管（CHANGELOG_69）：
 * - mount 时通过 window.api.getSettings() 与资产 list 一起 Promise.allSettled
 * - update(patch) 内部 dedup seq（防快速点击 toggle 时旧响应回写，仿 SettingsDialog M9 套路）
 * - 与 SettingsDialog 不共享 state——两 dialog 不会同时打开（都是模态），切换时各自重 fetch
 *
 * dirty 拦截契约（从 SettingsDialog 迁过来，套路相同）：
 * - ClaudeMdEditor 通过 `onDirtyChange` 上报草稿；ref 持有避免父级重渲染
 * - X 关闭 / 切走 claude-md tab 前调 `confirmDiscardClaudeMd` 二次确认
 * - `onClaudeMdDirtyChange` 用 useCallback 稳定 identity，否则 child useEffect cleanup→run
 *   会在 parent rerender 时误触发伪 false（REVIEW_4 M11 教训）
 * - InjectionToggleBar 是即改即生效（点击即写 settings），无 dirty 概念，不需新增拦截
 */

interface Props {
  open: boolean;
  onClose: () => void;
}

type TabKey = 'skills' | 'agents' | 'claude-md';

interface EditorState {
  kind: AssetKind;
  asset: AssetMeta | null;
}

export function AssetsLibraryDialog({ open, onClose }: Props): JSX.Element | null {
  const [tab, setTab] = useState<TabKey>('skills');
  const [bundled, setBundled] = useState<BundledAssetsSnapshot | null>(null);
  const [user, setUser] = useState<UserAssetsSnapshot | null>(null);
  /** CHANGELOG_69：settings 自管。三 tab 顶部 InjectionToggleBar 读这个 + 写 update。 */
  const [settings, setSettings] = useState<AppSettings | null>(null);
  /** CHANGELOG_69：toggle 写错误（与 loadError 分两 slot 避免互相覆盖）。 */
  const [updateError, setUpdateError] = useState<string | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [viewer, setViewer] = useState<ContentViewerState | null>(null);
  const [editor, setEditor] = useState<EditorState | null>(null);

  /** Mount fetch / refreshUser 用此 seq 比对，老响应回写到本地 state 时 abort
   *  （CHANGELOG_57 R1·F7：Promise.allSettled 无 cleanup，open→close→open 快切 + refreshUser 慢响应
   *  覆盖刚保存的 user 列表）。每次 open=true 自增；cleanup 不需要单独写——seq 是 lifeline。 */
  const fetchSeqRef = useRef(0);
  /** Viewer fetch 的 seq guard（CHANGELOG_57 R1·F5：闭包捕获 stale asset 导致 A 慢响应覆盖 B 视图） */
  const viewerSeqRef = useRef(0);
  /** CHANGELOG_69：update 请求序号。仿 SettingsDialog REVIEW_4 M9：连点多个 toggle 时慢响应回写旧值会被丢弃。 */
  const updateSeqRef = useRef(0);
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
      // plan reviewer-codex-cross-adapter-20260519 §Phase 5 Step 5.1 reviewer-codex MED finding fix:
      // close dialog 路径必须自增 viewerSeqRef 失效 in-flight fetch,防止 fetch 迟到时
      // `seq === viewerSeqRef.current` 仍成立 setViewer 复活 modal
      ++viewerSeqRef.current;
      setViewer(null);
      setEditor(null);
      return;
    }
    const seq = ++fetchSeqRef.current;
    setUpdateError(null);
    void Promise.allSettled([
      window.api.listBundledAssets(),
      window.api.listUserAssets(),
      window.api.getSettings(),
    ]).then(([b, u, s]) => {
      if (seq !== fetchSeqRef.current) return; // 老 open 的迟到响应：丢
      const errs: string[] = [];
      if (b.status === 'fulfilled') setBundled(b.value);
      else errs.push(`内置资产读取失败：${(b.reason as Error).message}`);
      if (u.status === 'fulfilled') setUser(u.value);
      else errs.push(`用户资产读取失败：${(u.reason as Error).message}`);
      if (s.status === 'fulfilled') {
        // 用 DEFAULT_SETTINGS 兜底（仿 SettingsDialog M8）：HMR / schema 漂移时缺字段不崩
        setSettings({ ...DEFAULT_SETTINGS, ...((s.value as Partial<AppSettings>) ?? {}) });
      } else {
        errs.push(`settings 读取失败：${(s.reason as Error).message}`);
        // 降级用 DEFAULT_SETTINGS 兜底渲染 InjectionToggleBar，至少 toggle 可见
        setSettings((prev) => prev ?? { ...DEFAULT_SETTINGS });
      }
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
   * CHANGELOG_69：toggle 写。仿 SettingsDialog.update 的 dedup 套路（REVIEW_4 M9）。
   * busy slot 这边没有——toggle 不展示 disable 态，避免 IPC 期间 UI 闪烁；
   * dedup 由 updateSeqRef 兜底防慢响应回写。
   */
  const updateSettings = async (patch: Partial<AppSettings>): Promise<void> => {
    const seq = ++updateSeqRef.current;
    setUpdateError(null);
    try {
      const next = (await window.api.setSettings(patch)) as Partial<AppSettings> | undefined;
      if (seq !== updateSeqRef.current) return;
      setSettings({ ...DEFAULT_SETTINGS, ...((next ?? {}) as Partial<AppSettings>) });
    } catch (err) {
      if (seq !== updateSeqRef.current) return;
      setUpdateError(`保存设置失败：${(err as Error).message ?? String(err)}`);
    }
  };

  /**
   * 关闭 viewer：自增 viewerSeqRef 失效所有 in-flight fetch + setViewer(null) reset state。
   *
   * **plan reviewer-codex-cross-adapter-20260519 §Phase 5 Step 5.1 reviewer-codex MED finding fix**:
   * 旧版 `onClose: () => setViewer(null)` 不增 seq → fetch 迟到 resolved 时
   * `seq === viewerSeqRef.current` 仍成立,会 setViewer 重塞 viewer state 复活 modal(用户关
   * 后 fetch 迟到把 modal 又显示出来)。修法:onClose / open=false cleanup 都先 ++seq 再 setViewer(null)。
   */
  const closeViewer = (): void => {
    ++viewerSeqRef.current;
    setViewer(null);
  };

  /**
   * 打开 viewer：seq guard 防 closure 捕获 stale asset。用户先点 A 后点 B 时，
   * 即使 A 的 fetch 比 B 慢，也只接受当前最新 seq 的响应（CHANGELOG_57 R1·F5）。
   *
   * **plan codex-handoff-team-alignment-20260518 §P3 Step 3.4**：getAssetContent 第 4 参数
   * `adapter` 直接透传 `asset.adapter`（bundled='claude-code'|'codex-cli' / user=null）。
   *
   * **plan reviewer-codex-cross-adapter-20260519 §Phase 4 Step 4.2**：input 改成 group
   * （`NonEmptyAssetGroup`，1=single 或 2=dual-adapter SKILL）。default 选 first asset's adapter
   * （`dedupBundledByName` 已按 claude-code 优先 / codex-cli 后排序，default 选 [claude]）。
   *
   * **plan §Phase 5 Step 5.1 reviewer-codex LOW finding fix**：fetch 链补 `.catch` 处理 IPC
   * invoke reject 路径(handler throw / IPC channel error),否则 viewer 永久卡 `读取中…` loading
   * 态 + unhandled rejection。catch 仍受 seq guard 约束(seq 不一致 = 已被 close/切 tab 失效)。
   */
  const openViewer = (assets: NonEmptyAssetGroup): void => {
    const first = assets[0];
    const seq = ++viewerSeqRef.current;
    setViewer({ assets, currentAdapter: first.adapter, content: null, error: null });
    void window.api
      .getAssetContent(first.kind, first.name, first.source, first.adapter)
      .then((r) => {
        if (seq !== viewerSeqRef.current) return;
        if (r.ok) setViewer({ assets, currentAdapter: first.adapter, content: r.content, error: null });
        else setViewer({ assets, currentAdapter: first.adapter, content: null, error: r.reason ?? '未知错误' });
      })
      .catch((err) => {
        if (seq !== viewerSeqRef.current) return;
        setViewer({
          assets,
          currentAdapter: first.adapter,
          content: null,
          error: `IPC 调用失败：${(err as Error).message ?? String(err)}`,
        });
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

        {updateError && (
          <div className="mb-3 rounded border border-status-waiting/40 bg-status-waiting/10 p-2 text-[11px] text-status-waiting whitespace-pre-wrap">
            {updateError}
          </div>
        )}

        <div className="flex-1 overflow-y-auto scrollbar-deck pr-1">
          {tab === 'skills' && (
            <>
              <InjectionToggleBar tab="skills" settings={settings} update={updateSettings} />
              <AssetsTab
                kind="skill"
                bundled={bundled?.skills ?? []}
                user={user?.skills ?? []}
                onView={openViewer}
                onEdit={(asset) => setEditor({ kind: 'skill', asset })}
                onNew={() => setEditor({ kind: 'skill', asset: null })}
              />
            </>
          )}
          {tab === 'agents' && (
            <>
              <InjectionToggleBar tab="agents" settings={settings} update={updateSettings} />
              <AssetsTab
                kind="agent"
                bundled={bundled?.agents ?? []}
                user={user?.agents ?? []}
                onView={openViewer}
                onEdit={(asset) => setEditor({ kind: 'agent', asset })}
                onNew={() => setEditor({ kind: 'agent', asset: null })}
              />
            </>
          )}
          {tab === 'claude-md' && (
            <>
              <InjectionToggleBar tab="claude-md" settings={settings} update={updateSettings} />
              <ClaudeMdTab onDirtyChange={onClaudeMdDirtyChange} />
            </>
          )}
        </div>
      </div>

      {viewer && (
        <ContentViewerModal
          state={viewer}
          onReveal={() => {
            // reveal 当前选中 tab 对应文件（dual-adapter SKILL 切 tab 后 reveal 切到对应文件位置）
            const cur = viewer.assets.find((a) => a.adapter === viewer.currentAdapter) ?? viewer.assets[0];
            void window.api.revealAssetInFolder(cur.kind, cur.name, cur.source, cur.adapter);
          }}
          onTabSwitch={(adapter) => {
            // dual-adapter tab 切换：seq guard fetch 切到目标 adapter 的内容
            // closure 每次 render 重建拿到最新 viewer state；React 18 batched update 队列保证一致性
            // plan §Phase 5 Step 5.1 reviewer-codex LOW finding fix: fetch 链补 .catch 处理 IPC reject
            const target = viewer.assets.find((a) => a.adapter === adapter);
            if (!target || adapter === viewer.currentAdapter) return;
            const seq = ++viewerSeqRef.current;
            setViewer({ assets: viewer.assets, currentAdapter: adapter, content: null, error: null });
            void window.api
              .getAssetContent(target.kind, target.name, target.source, target.adapter)
              .then((r) => {
                if (seq !== viewerSeqRef.current) return;
                if (r.ok) setViewer({ assets: viewer.assets, currentAdapter: adapter, content: r.content, error: null });
                else setViewer({ assets: viewer.assets, currentAdapter: adapter, content: null, error: r.reason ?? '未知错误' });
              })
              .catch((err) => {
                if (seq !== viewerSeqRef.current) return;
                setViewer({
                  assets: viewer.assets,
                  currentAdapter: adapter,
                  content: null,
                  error: `IPC 调用失败：${(err as Error).message ?? String(err)}`,
                });
              });
          }}
          onClose={closeViewer}
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
  onView: (assets: NonEmptyAssetGroup) => void;
  onEdit: (asset: AssetMeta) => void;
  onNew: () => void;
}): JSX.Element {
  // bundled (kind+name) group dedup —— Phase 4 Step 4.1 同名跨 adapter 合并为单条双角标
  // user assets 不会跨 adapter，直接每条包 [asset] 单元素数组喂给 AssetCard
  const bundledGroups = dedupBundledByName(bundled);
  return (
    <div className="flex flex-col gap-3">
      <section>
        <div className="mb-1 text-[10px] uppercase tracking-wider text-deck-muted/70">
          内置（agent-deck plugin，只读）
        </div>
        {bundledGroups.length === 0 ? (
          <div className="text-[10px] text-deck-muted/60">（无）</div>
        ) : (
          <div className="flex flex-col gap-1.5">
            {bundledGroups.map((group) => (
              <AssetCard key={`${group[0].kind}:${group[0].name}`} assets={group} onView={onView} />
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
              <AssetCard key={a.qualifiedName} assets={[a] as const} onView={onView} onEdit={onEdit} />
            ))}
          </div>
        )}
      </section>
    </div>
  );
}

/**
 * 「应用约定」tab:加 adapter switcher(Claude / Codex 二选一)分别渲染对应编辑器。
 *
 * - Claude 视角:`resources/claude-config/CLAUDE.md` 注入到每个 claude SDK 会话 system prompt
 *   末尾(独立于 user/project/local CLAUDE.md,避免和 Claude Code 自带 memory 文件混淆)
 * - Codex 视角:`resources/codex-config/CODEX_AGENTS.md` 同步到 ~/.codex/AGENTS.md Agent Deck
 *   marker 段(用户其他 marker 外内容严格保留)
 *
 * dirty 上报双层:
 * - 子 editor 通过 onSubDirty 上报,本组件 forward 给父级 onDirtyChange(让父级关闭弹窗时拦截)
 * - 子 adapter 切换时本组件**也**用同款 confirmDialog 拦截(否则 dirty 草稿会随子 editor unmount
 *   静默丢失 — adapter switcher 行为应与主 tab 切换对称)
 */
function ClaudeMdTab({
  onDirtyChange,
}: {
  onDirtyChange: (dirty: boolean) => void;
}): JSX.Element {
  const [adapter, setAdapter] = useState<'claude' | 'codex'>('claude');
  const subDirtyRef = useRef(false);

  // forward 给父级,让 dialog 关闭 / 主 tab 切换时拦截 — 与 ClaudeMdTab 之前直接 forward 单 editor
  // dirty 同款契约。子 editor unmount 时 useEffect cleanup 会上报 false,本 ref 自然回 false。
  const onSubDirty = useCallback(
    (d: boolean) => {
      subDirtyRef.current = d;
      onDirtyChange(d);
    },
    [onDirtyChange],
  );

  // 子 adapter 切换前的二次确认 — 与主 tab 切换 confirmDiscardClaudeMd 同款语义,但 prompt 文案
  // 区分 (Claude / Codex 都说「应用约定」即可,不用细分)。
  const switchAdapter = async (next: 'claude' | 'codex'): Promise<void> => {
    if (next === adapter) return;
    if (subDirtyRef.current) {
      const ok = await window.api.confirmDialog({
        title: '切换视角',
        message: '应用约定有未保存的草稿,确定要丢弃吗?',
        detail: '切换后改动将丢失,无法恢复。',
        okLabel: '丢弃并切换',
        cancelLabel: '继续编辑',
        destructive: true,
      });
      if (!ok) return;
    }
    setAdapter(next);
  };

  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center gap-1 text-[11px]">
        <span className="text-[10px] text-deck-muted/70">视角:</span>
        <SubTabBtn active={adapter === 'claude'} onClick={() => void switchAdapter('claude')}>
          Claude
        </SubTabBtn>
        <SubTabBtn active={adapter === 'codex'} onClick={() => void switchAdapter('codex')}>
          Codex
        </SubTabBtn>
      </div>
      {adapter === 'claude' ? (
        <>
          <div className="text-[10px] leading-snug text-deck-muted/70">
            应用内置 CLAUDE.md，独立于 user / project / local CLAUDE.md，
            拼到每个 claude SDK 会话 system prompt 末尾。改动只对「下次新建会话」生效。
          </div>
          <ClaudeMdEditor onDirtyChange={onSubDirty} />
        </>
      ) : (
        <>
          <div className="text-[10px] leading-snug text-deck-muted/70">
            应用内置 CODEX_AGENTS.md，同步到 ~/.codex/AGENTS.md 内 Agent Deck marker 段
            (用户其他 marker 外内容严格保留)。改动只对「下次新建 codex 会话」生效。
          </div>
          <CodexAgentsMdEditor onDirtyChange={onSubDirty} />
        </>
      )}
    </div>
  );
}

function SubTabBtn({
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
      className={`rounded px-2 py-0.5 text-[10px] transition-colors ${
        active
          ? 'bg-status-working/20 text-status-working'
          : 'bg-white/5 text-deck-muted hover:bg-white/10 hover:text-deck-text'
      }`}
    >
      {children}
    </button>
  );
}
