import { useCallback, useEffect, useRef, useState, type JSX } from 'react';
import {
  DEFAULT_SETTINGS,
  type AppSettings,
  type AssetKind,
  type AssetMeta,
  type BundledAssetsSnapshot,
  type UserAssetAdapter,
  type UserAssetsSnapshot,
} from '@shared/types';
import { AdapterSubTab, type AssetAdapter } from './assets/AdapterSubTab';
import { AssetsTab } from './assets/AssetsTab';
import { AssetEditor } from './assets/AssetEditor';
import { BundledAgentRuntimeEditor } from './assets/BundledAgentRuntimeEditor';
import { ApplicationConventionTab } from './assets/ApplicationConventionTab';
import { ContentViewerModal, type ContentViewerState } from './assets/ContentViewerModal';
import { InjectionToggleBar } from './assets/InjectionToggleBar';
import { CloseIcon, LibraryIcon } from './icons';
import { errorMessage } from '@renderer/lib/error-message';

/**
 * 资产库 Dialog（CHANGELOG_57 / CHANGELOG_69 / CHANGELOG_137 / plan
 * assets-codex-user-and-ui-unify-20260521 §D1-D7：三 tab 全 sub-tab 切换 paradigm 统一 + codex
 * 端 user 自定义补齐）。
 *
 * 三 Tab，每 tab 内部按 adapter sub-tab 切换：
 * - Skills：sub-tab(Claude/Codex)，bundled + user 各 sub-tab 内独立显示;Codex sub-tab user
 *   skill 落 ~/.codex/skills/<name>/SKILL.md(spike4 实证 codex CLI 自动加载)
 * - Agents：sub-tab(Claude/Codex)，Claude user agents 落 ~/.claude/agents/，Codex custom
 *   agents 落 ~/.codex/agents/*.toml
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
  adapter: UserAssetAdapter;
  asset: (AssetMeta & { adapter: UserAssetAdapter }) | null;
}

function isUserAssetMeta(
  asset: AssetMeta,
): asset is AssetMeta & { adapter: UserAssetAdapter } {
  return asset.adapter !== 'grok-build';
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
  const [bundledAgentEditor, setBundledAgentEditor] = useState<AssetMeta | null>(null);
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
      setBundledAgentEditor(null);
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
        errs.push(`设置读取失败：${errorMessage(s.reason)}`);
        setSettings((prev) => prev ?? { ...DEFAULT_SETTINGS });
      }
      setLoadError(errs.length > 0 ? errs.join('\n') : null);
    });
  }, [open]);

  const refreshUser = (): void => {
    const seq = ++fetchSeqRef.current;
    void window.api
      .listUserAssets()
      .then((u) => {
        if (seq !== fetchSeqRef.current) return;
        setUser(u);
      })
      .catch((err: unknown) => {
        if (seq !== fetchSeqRef.current) return;
        setLoadError(`用户资产刷新失败：${errorMessage(err)}`);
      });
  };

  const refreshBundled = (): void => {
    const seq = ++fetchSeqRef.current;
    void window.api
      .listBundledAssets()
      .then((snapshot) => {
        if (seq === fetchSeqRef.current) setBundled(snapshot);
      })
      .catch((err: unknown) => {
        if (seq === fetchSeqRef.current) {
          setLoadError(`内置资产刷新失败：${errorMessage(err)}`);
        }
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
          error: `加载失败：${(err as Error).message ?? String(err)}`,
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
            <h2 className="flex items-center gap-1.5 text-[13px] font-medium">
              <LibraryIcon className="h-4 w-4" />资产库
            </h2>
            <span className="text-[10px] text-deck-muted/70">(Skills / Agents / 应用约定)</span>
          </div>
          <button
            type="button"
            onClick={() => void guardedClose()}
            aria-label="关闭资产库"
            className="flex h-5 w-5 items-center justify-center rounded text-[11px] text-deck-muted hover:bg-white/10"
          >
            <CloseIcon className="h-3.5 w-3.5" />
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
                <AdapterSubTab current={skillsAdapter} onSelect={setSkillsAdapter} showGrok />
              </div>
              <AssetsTab
                kind="skill"
                adapter={skillsAdapter}
                bundled={bundled?.skills ?? []}
                user={user?.skills ?? []}
                onView={openViewer}
                onEdit={(asset) => {
                  if (skillsAdapter !== 'grok-build' && isUserAssetMeta(asset)) {
                    setEditor({ kind: 'skill', adapter: skillsAdapter, asset });
                  }
                }}
                onNew={
                  skillsAdapter === 'grok-build'
                    ? undefined
                    : () => setEditor({ kind: 'skill', adapter: skillsAdapter, asset: null })
                }
              />
            </>
          )}
          {tab === 'agents' && (
            <>
              <InjectionToggleBar tab="agents" settings={settings} update={updateSettings} />
              <div className="mb-2">
                <AdapterSubTab current={agentsAdapter} onSelect={setAgentsAdapter} showGrok />
              </div>
              <AssetsTab
                kind="agent"
                adapter={agentsAdapter}
                bundled={bundled?.agents ?? []}
                user={user?.agents ?? []}
                onView={openViewer}
                onConfigureBundledAgent={setBundledAgentEditor}
                onEdit={(asset) => {
                  if (agentsAdapter !== 'grok-build' && isUserAssetMeta(asset)) {
                    setEditor({ kind: 'agent', adapter: agentsAdapter, asset });
                  }
                }}
                onNew={
                  agentsAdapter === 'grok-build'
                    ? undefined
                    : () => setEditor({ kind: 'agent', adapter: agentsAdapter, asset: null })
                }
              />
            </>
          )}
          {tab === 'claude-md' && (
            <>
              <InjectionToggleBar tab="claude-md" settings={settings} update={updateSettings} />
              <ApplicationConventionTab onDirtyChange={onClaudeMdDirtyChange} />
            </>
          )}
        </div>
      </div>

      {viewer && (
        <ContentViewerModal
          state={viewer}
          onReveal={() => {
            void window.api
              .revealAssetInFolder(
                viewer.asset.kind,
                viewer.asset.name,
                viewer.asset.source,
                viewer.asset.adapter,
              )
              .catch((err: unknown) => {
                setUpdateError(`无法在文件夹中显示：${errorMessage(err)}`);
              });
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
      {bundledAgentEditor && (
        <BundledAgentRuntimeEditor
          asset={bundledAgentEditor}
          onClose={() => setBundledAgentEditor(null)}
          onSaved={refreshBundled}
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
