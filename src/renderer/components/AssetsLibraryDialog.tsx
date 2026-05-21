import { useCallback, useEffect, useRef, useState, type JSX } from 'react';
import { DEFAULT_SETTINGS, type AppSettings, type AssetKind, type AssetMeta, type BundledAssetsSnapshot, type UserAssetsSnapshot } from '@shared/types';
import { AdapterSubTab, type AssetAdapter } from './assets/AdapterSubTab';
import { AssetCard } from './assets/AssetCard';
import { AssetEditor } from './assets/AssetEditor';
import { ContentViewerModal, type ContentViewerState } from './assets/ContentViewerModal';
import { InjectionToggleBar } from './assets/InjectionToggleBar';
import { ClaudeMdEditor } from './settings/ClaudeMdEditor';
import { CodexAgentsMdEditor } from './settings/CodexAgentsMdEditor';

/**
 * 资产库 Dialog（CHANGELOG_57 / CHANGELOG_69 / CHANGELOG_137 / plan
 * assets-codex-user-and-ui-unify-20260521 §D1-D7：三 tab 全 sub-tab 切换 paradigm 统一 + codex
 * 端 user 自定义补齐）。
 *
 * 三 Tab，每 tab 内部按 adapter sub-tab 切换：
 * - Skills：sub-tab(Claude/Codex)，bundled + user 各 sub-tab 内独立显示;Codex sub-tab user
 *   skill 落 ~/.codex/skills/<name>/SKILL.md(spike4 实证 codex CLI 自动加载)
 * - Agents：sub-tab(Claude/Codex)，Codex sub-tab user section 显「不支持」banner（codex CLI
 *   无 user agent 概念，OpenAI 文档 + spike4 实证 §D3）
 * - 应用约定：sub-tab(Claude/Codex)，子 editor dirty 时切换前 confirm 拦截
 *
 * dirty 拦截契约：
 * - ClaudeMdEditor / CodexAgentsMdEditor 通过 `onDirtyChange` 上报草稿；ref 持有避免父级重渲染
 * - X 关闭 / 切走 claude-md tab 前调 `confirmDiscardClaudeMd` 二次确认
 * - 应用约定 sub-tab 切换前 AdapterSubTab onSwitch hook 拦截（dirty 时 confirm）
 * - Skills/Agents sub-tab 切换无 dirty 风险（filter 视图变更不丢草稿），AdapterSubTab 不传 onSwitch
 */

interface Props {
  open: boolean;
  onClose: () => void;
}

type TabKey = 'skills' | 'agents' | 'claude-md';

interface EditorState {
  kind: AssetKind;
  adapter: AssetAdapter;
  asset: AssetMeta | null;
}

export function AssetsLibraryDialog({ open, onClose }: Props): JSX.Element | null {
  const [tab, setTab] = useState<TabKey>('skills');
  const [bundled, setBundled] = useState<BundledAssetsSnapshot | null>(null);
  const [user, setUser] = useState<UserAssetsSnapshot | null>(null);
  const [settings, setSettings] = useState<AppSettings | null>(null);
  const [updateError, setUpdateError] = useState<string | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [viewer, setViewer] = useState<ContentViewerState | null>(null);
  const [editor, setEditor] = useState<EditorState | null>(null);
  // plan §D1：Skills/Agents 各 tab 独立 sub-tab state（切换其他 tab 不影响其他 tab 的 sub-tab）
  const [skillsAdapter, setSkillsAdapter] = useState<AssetAdapter>('claude-code');
  const [agentsAdapter, setAgentsAdapter] = useState<AssetAdapter>('claude-code');

  const fetchSeqRef = useRef(0);
  const viewerSeqRef = useRef(0);
  const updateSeqRef = useRef(0);
  const claudeMdDirtyRef = useRef(false);
  const closeInFlightRef = useRef(false);

  const onClaudeMdDirtyChange = useCallback((d: boolean) => {
    claudeMdDirtyRef.current = d;
  }, []);

  useEffect(() => {
    if (!open) {
      // close dialog 路径必须自增 viewerSeqRef 失效 in-flight fetch（plan reviewer-codex-cross-adapter
      // -20260519 §Phase 5 Step 5.1 reviewer-codex MED finding fix）
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
      if (seq !== fetchSeqRef.current) return;
      const errs: string[] = [];
      if (b.status === 'fulfilled') setBundled(b.value);
      else errs.push(`内置资产读取失败：${(b.reason as Error).message}`);
      if (u.status === 'fulfilled') setUser(u.value);
      else errs.push(`用户资产读取失败：${(u.reason as Error).message}`);
      if (s.status === 'fulfilled') {
        setSettings({ ...DEFAULT_SETTINGS, ...((s.value as Partial<AppSettings>) ?? {}) });
      } else {
        errs.push(`settings 读取失败：${(s.reason as Error).message}`);
        setSettings((prev) => prev ?? { ...DEFAULT_SETTINGS });
      }
      setLoadError(errs.length > 0 ? errs.join('\n') : null);
    });
  }, [open]);

  const refreshUser = (): void => {
    const seq = ++fetchSeqRef.current;
    void window.api.listUserAssets().then((u) => {
      if (seq !== fetchSeqRef.current) return;
      setUser(u);
    });
  };

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

  const closeViewer = (): void => {
    ++viewerSeqRef.current;
    setViewer(null);
  };

  /**
   * 打开 viewer：单 asset 模式（plan §D6 删 dual-adapter tab 切换器）。seq guard 防 closure
   * 捕获 stale asset；fetch 链补 .catch 处理 IPC reject 防 viewer 永久卡 loading。
   */
  const openViewer = (asset: AssetMeta): void => {
    const seq = ++viewerSeqRef.current;
    setViewer({ asset, content: null, error: null });
    void window.api
      .getAssetContent(asset.kind, asset.name, asset.source, asset.adapter)
      .then((r) => {
        if (seq !== viewerSeqRef.current) return;
        if (r.ok) setViewer({ asset, content: r.content, error: null });
        else setViewer({ asset, content: null, error: r.reason ?? '未知错误' });
      })
      .catch((err) => {
        if (seq !== viewerSeqRef.current) return;
        setViewer({
          asset,
          content: null,
          error: `IPC 调用失败：${(err as Error).message ?? String(err)}`,
        });
      });
  };

  const confirmDiscardClaudeMd = async (kind: 'close' | 'switch'): Promise<boolean> => {
    if (closeInFlightRef.current) return false;
    if (!claudeMdDirtyRef.current) return true;
    closeInFlightRef.current = true;
    try {
      return await window.api.confirmDialog({
        title: kind === 'close' ? '关闭资产库' : '切换标签',
        message: '应用约定有未保存的草稿，确定要丢弃吗？',
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
              <div className="mb-2">
                <AdapterSubTab current={skillsAdapter} onSelect={setSkillsAdapter} />
              </div>
              <AssetsTab
                kind="skill"
                adapter={skillsAdapter}
                bundled={bundled?.skills ?? []}
                user={user?.skills ?? []}
                onView={openViewer}
                onEdit={(asset) => setEditor({ kind: 'skill', adapter: skillsAdapter, asset })}
                onNew={() => setEditor({ kind: 'skill', adapter: skillsAdapter, asset: null })}
              />
            </>
          )}
          {tab === 'agents' && (
            <>
              <InjectionToggleBar tab="agents" settings={settings} update={updateSettings} />
              <div className="mb-2">
                <AdapterSubTab current={agentsAdapter} onSelect={setAgentsAdapter} />
              </div>
              <AssetsTab
                kind="agent"
                adapter={agentsAdapter}
                bundled={bundled?.agents ?? []}
                user={user?.agents ?? []}
                onView={openViewer}
                onEdit={(asset) => setEditor({ kind: 'agent', adapter: agentsAdapter, asset })}
                onNew={() => setEditor({ kind: 'agent', adapter: agentsAdapter, asset: null })}
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
            void window.api.revealAssetInFolder(viewer.asset.kind, viewer.asset.name, viewer.asset.source, viewer.asset.adapter);
          }}
          onClose={closeViewer}
        />
      )}
      {editor && (
        <AssetEditor
          kind={editor.kind}
          adapter={editor.adapter}
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

/**
 * Skills/Agents tab 内部 adapter filter 视图（plan §D1 §D6）：bundled / user 都按 adapter
 * filter；Agents tab Codex sub-tab user section 显「不支持」banner（plan §D3 不变量 #4）。
 */
function AssetsTab({
  kind,
  adapter,
  bundled,
  user,
  onView,
  onEdit,
  onNew,
}: {
  kind: AssetKind;
  adapter: AssetAdapter;
  bundled: AssetMeta[];
  user: AssetMeta[];
  onView: (asset: AssetMeta) => void;
  onEdit: (asset: AssetMeta) => void;
  onNew: () => void;
}): JSX.Element {
  // plan §D6 删 dedupBundledByName,直接按 adapter filter
  const filteredBundled = bundled.filter((a) => a.adapter === adapter);
  const filteredUser = user.filter((a) => a.adapter === adapter);
  // plan §D3 不变量 #4：Codex sub-tab Agents tab 不支持 user agent
  const codexAgentBanner = kind === 'agent' && adapter === 'codex-cli';
  // plan §D2 §D5：user 资产路径 hint 文案 sub-tab 切换
  const userPathHint =
    adapter === 'claude-code'
      ? kind === 'agent'
        ? '~/.claude/agents/'
        : '~/.claude/skills/'
      : '~/.codex/skills/';
  return (
    <div className="flex flex-col gap-3">
      <section>
        <div className="mb-1 text-[10px] uppercase tracking-wider text-deck-muted/70">
          内置（agent-deck plugin，只读）
        </div>
        {filteredBundled.length === 0 ? (
          <div className="text-[10px] text-deck-muted/60">（无）</div>
        ) : (
          <div className="flex flex-col gap-1.5">
            {filteredBundled.map((a) => (
              <AssetCard key={`${a.adapter}:${a.qualifiedName}`} asset={a} onView={onView} />
            ))}
          </div>
        )}
      </section>

      <section>
        <div className="mb-1 flex items-center justify-between">
          <div className="text-[10px] uppercase tracking-wider text-deck-muted/70">
            用户自定义（{userPathHint}）
          </div>
          {!codexAgentBanner && (
            <button
              type="button"
              onClick={onNew}
              className="rounded bg-status-working/15 px-2 py-0.5 text-[10px] text-status-working hover:bg-status-working/25"
            >
              + 新建{kind === 'agent' ? ' Agent' : ' Skill'}
            </button>
          )}
        </div>
        {codexAgentBanner ? (
          <div className="rounded border border-deck-border/60 bg-white/[0.03] p-2 text-[10px] leading-relaxed text-deck-muted/80">
            codex CLI 不原生支持 user 自定义 agent（OpenAI 官方文档明确「Codex CLI has skills concept only」）。
            如需 codex 自定义能力，请改建 codex skill（切到 Skills tab → Codex sub-tab），或在 spawn 时直接传完整 prompt。
          </div>
        ) : filteredUser.length === 0 ? (
          <div className="text-[10px] text-deck-muted/60">
            暂无；点右上「新建」可创建第一个用户自定义{kind === 'agent' ? ' agent' : ' skill'}（落盘到 {userPathHint}）
          </div>
        ) : (
          <div className="flex flex-col gap-1.5">
            {filteredUser.map((a) => (
              <AssetCard key={`${a.adapter}:${a.qualifiedName}`} asset={a} onView={onView} onEdit={onEdit} />
            ))}
          </div>
        )}
      </section>
    </div>
  );
}

/**
 * 「应用约定」tab：Claude / Codex sub-tab 切换分别渲染对应编辑器（CHANGELOG_137）。
 *
 * **plan assets-codex-user-and-ui-unify-20260521 §D1**：本 tab 改用公共 AdapterSubTab 组件，
 * 与 Skills/Agents 三 tab UI paradigm 一致；onSwitch hook 仍保留 dirty 拦截（子 editor 持有
 * 未保存草稿时弹 confirmDialog）。
 *
 * dirty 上报双层:
 * - 子 editor 通过 onSubDirty 上报,本组件 forward 给父级 onDirtyChange(让父级关闭弹窗时拦截)
 * - 子 adapter 切换时 AdapterSubTab onSwitch 拦截 dirty(否则草稿随子 editor unmount 静默丢失)
 */
function ClaudeMdTab({
  onDirtyChange,
}: {
  onDirtyChange: (dirty: boolean) => void;
}): JSX.Element {
  const [adapter, setAdapter] = useState<AssetAdapter>('claude-code');
  const subDirtyRef = useRef(false);

  const onSubDirty = useCallback(
    (d: boolean) => {
      subDirtyRef.current = d;
      onDirtyChange(d);
    },
    [onDirtyChange],
  );

  // dirty 拦截：子 editor 持有未保存草稿时弹 confirmDialog 拦截 sub-tab 切换
  const guardSwitchAdapter = async (_next: AssetAdapter): Promise<boolean> => {
    if (!subDirtyRef.current) return true;
    return window.api.confirmDialog({
      title: '切换视角',
      message: '应用约定有未保存的草稿,确定要丢弃吗?',
      detail: '切换后改动将丢失,无法恢复。',
      okLabel: '丢弃并切换',
      cancelLabel: '继续编辑',
      destructive: true,
    });
  };

  return (
    <div className="flex flex-col gap-2">
      <AdapterSubTab current={adapter} onSelect={setAdapter} onSwitch={guardSwitchAdapter} />
      {adapter === 'claude-code' ? (
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
