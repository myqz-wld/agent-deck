import { useEffect, useRef, useState, type JSX } from 'react';
import { DEFAULT_SETTINGS, type AppSettings, type HookInstallStatus } from '@shared/types';
import { SectionGroup } from './settings/controls';
import { HookSection } from './settings/sections/HookSection';
import { NotifySection } from './settings/sections/NotifySection';
import { LifecycleSection } from './settings/sections/LifecycleSection';
import { SummarySection } from './settings/sections/SummarySection';
import { WindowSection } from './settings/sections/WindowSection';
import { KeyboardShortcutsSection } from './settings/sections/KeyboardShortcutsSection';
import { HookServerSection } from './settings/sections/HookServerSection';
import { ExternalToolsSection } from './settings/sections/ExternalToolsSection';
import { ExperimentalSection } from './settings/sections/ExperimentalSection';
import { AgentDeckMcpSection } from './settings/sections/AgentDeckMcpSection';

interface Props {
  open: boolean;
  onClose: () => void;
}

/**
 * 设置弹窗外壳：负责 settings/hookStatus 加载、update IPC 调用、section 编排。
 *
 * CHANGELOG_69：信息架构重组 ——
 * - 删 3 个「资产注入」section（ClaudeMd / PluginAssets / CodexInjection），5 个 toggle 整体迁
 *   到 AssetsLibraryDialog 三 tab 顶部，实现「资产编辑 + 注入开关」单一真源
 * - 剩 10 个 section 按 4 主题分组（会话 / 提醒与外观 / 集成与运行环境 / 跨工具协作）加视觉分隔标题
 * - 默认展开项从 HookSection 改到 LifecycleSection（首装引导早已结束）
 * - 不再持有 onOpenAssetsLibrary prop（设置面板与资产库完全解耦，唯一访问点是 Header「📚 资产库」按钮）
 *
 * 历史：CHANGELOG_57 D 把 9 个 section 拆到 settings/sections/ 子目录；CHANGELOG_58 把 CLAUDE.md
 * 编辑器迁到 AssetsLibraryDialog；本轮 CHANGELOG_69 完成「设置 / 资产」彻底解耦。
 */
export function SettingsDialog({ open, onClose }: Props): JSX.Element | null {
  const [settings, setSettings] = useState<AppSettings | null>(null);
  const [hookStatus, setHookStatus] = useState<HookInstallStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  /** CHANGELOG_160:三 tab 分组(通用 / claude code / codex cli)。tab state per-open 重置
   *  到 'general' 让用户每次打开 settings 从总览开始。 */
  const [activeTab, setActiveTab] = useState<'general' | 'claude' | 'codex'>('general');
  /** 写设置 / 安装 hook 的异步错误（CHANGELOG_20 / N7：原本 try/finally 无 catch，IPC 失败用户看不到原因）。
   *  与 loadError 分两个 slot 避免互相覆盖；写错误一段时间后会被下一次成功操作清掉。 */
  const [actionError, setActionError] = useState<string | null>(null);
  /** REVIEW_4 M9：每次重新打开都递增，旧 effect 的 then 回调用这个比对 abort，
   *  避免快速切换 open 时旧响应回写新打开的 state。 */
  const openSeqRef = useRef(0);
  /** REVIEW_4 M9：update 请求序号；连点多个 toggle 时慢响应回写旧值会被丢弃。 */
  const updateSeqRef = useRef(0);

  useEffect(() => {
    if (!open) return;
    const seq = ++openSeqRef.current;
    setLoadError(null);
    setActionError(null);
    setActiveTab('general');
    void window.api
      .getSettings()
      .then((s) => {
        if (seq !== openSeqRef.current) return; // 老 open 的迟到响应：丢
        // 用 DEFAULT_SETTINGS 兜底：main 端老 schema 缺字段时（HMR 不能 reload main，
        // 改了 AppSettings 后没重启 dev 就会缺新加的字段），前端表单仍能显示默认值。
        setSettings({ ...DEFAULT_SETTINGS, ...((s as Partial<AppSettings>) ?? {}) });
      })
      .catch((err: unknown) => {
        if (seq !== openSeqRef.current) return;
        setLoadError(`getSettings 失败：${(err as Error).message ?? String(err)}`);
        // REVIEW_4 M8：getSettings 失败时降级用 DEFAULT_SETTINGS 兜底渲染表单，
        // 让用户至少能看到完整设置面板而非死锁在「读取设置中…」。
        // 写设置仍可用（main 持久化独立），只是初始值是 default。
        setSettings((prev) => prev ?? { ...DEFAULT_SETTINGS });
      });
    void window.api
      .hookStatus('user')
      .then((s) => {
        if (seq !== openSeqRef.current) return;
        setHookStatus(s as HookInstallStatus);
      })
      .catch((err: unknown) => {
        if (seq !== openSeqRef.current) return;
        setLoadError(
          (prev) =>
            (prev ? prev + '\n' : '') +
            `hookStatus 失败：${(err as Error).message ?? String(err)}`,
        );
      });
  }, [open]);

  if (!open) return null;

  const update = async (patch: Partial<AppSettings>): Promise<void> => {
    // REVIEW_4 M9：递增请求序号，慢响应被新 update 抢答时丢弃，避免回写旧值 toggle 闪回
    const seq = ++updateSeqRef.current;
    setBusy(true);
    setActionError(null);
    try {
      const next = (await window.api.setSettings(patch)) as Partial<AppSettings> | undefined;
      if (seq !== updateSeqRef.current) return; // 老请求迟到，丢
      // 同样用 DEFAULT_SETTINGS 兜底（防 main 返回 partial）
      setSettings({ ...DEFAULT_SETTINGS, ...((next ?? {}) as Partial<AppSettings>) });
    } catch (err) {
      if (seq !== updateSeqRef.current) return;
      setActionError(`保存设置失败：${(err as Error).message ?? String(err)}`);
    } finally {
      if (seq === updateSeqRef.current) setBusy(false);
    }
  };

  const installHook = async (): Promise<void> => {
    setBusy(true);
    setActionError(null);
    try {
      const r = (await window.api.installHook('user')) as HookInstallStatus;
      setHookStatus(r);
    } catch (err) {
      setActionError(`安装 hook 失败：${(err as Error).message ?? String(err)}`);
    } finally {
      setBusy(false);
    }
  };
  const uninstallHook = async (): Promise<void> => {
    setBusy(true);
    setActionError(null);
    try {
      const r = (await window.api.uninstallHook('user')) as HookInstallStatus;
      setHookStatus(r);
    } catch (err) {
      setActionError(`卸载 hook 失败：${(err as Error).message ?? String(err)}`);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="absolute inset-0 z-40 flex items-center justify-center bg-black/40 backdrop-blur-sm">
      <div className="no-drag w-[340px] max-h-[85%] overflow-y-auto scrollbar-deck rounded-xl border border-deck-border bg-deck-bg-strong p-4 shadow-2xl">
        <header className="mb-3 flex items-center justify-between">
          <h2 className="text-[13px] font-medium">设置</h2>
          <button
            type="button"
            onClick={onClose}
            aria-label="关闭设置"
            className="flex h-5 w-5 items-center justify-center rounded text-[11px] text-deck-muted hover:bg-white/10"
          >
            ✕
          </button>
        </header>

        {loadError && (
          <div className="mb-3 rounded border border-status-waiting/40 bg-status-waiting/10 p-2 text-[11px] text-status-waiting whitespace-pre-wrap">
            {loadError}
          </div>
        )}

        {actionError && (
          <div className="mb-3 rounded border border-status-waiting/40 bg-status-waiting/10 p-2 text-[11px] text-status-waiting whitespace-pre-wrap">
            {actionError}
          </div>
        )}

        {!settings ? (
          <div className="py-6 text-center text-[11px] text-deck-muted">读取设置中…</div>
        ) : (
          <>
            <nav
              role="tablist"
              aria-label="设置 tab 切换"
              className="mb-3 flex gap-0.5 rounded-md border border-deck-border bg-white/[0.02] p-0.5"
            >
              {(
                [
                  { id: 'general', label: '通用' },
                  { id: 'claude', label: 'claude code' },
                  { id: 'codex', label: 'codex cli' },
                ] as const
              ).map((tab) => (
                <button
                  key={tab.id}
                  type="button"
                  role="tab"
                  aria-selected={activeTab === tab.id}
                  onClick={() => setActiveTab(tab.id)}
                  className={`no-drag flex-1 rounded px-2 py-1 text-[11px] transition-colors ${
                    activeTab === tab.id
                      ? 'bg-white/15 text-deck-text'
                      : 'text-deck-muted hover:bg-white/5 hover:text-deck-text'
                  }`}
                >
                  {tab.label}
                </button>
              ))}
            </nav>

            {activeTab === 'general' && (
              <>
                <SectionGroup title="会话">
                  <LifecycleSection settings={settings} update={update} />
                  <SummarySection settings={settings} update={update} />
                </SectionGroup>

                <SectionGroup title="提醒与外观">
                  <NotifySection settings={settings} update={update} />
                  <WindowSection settings={settings} update={update} />
                  <KeyboardShortcutsSection />
                </SectionGroup>

                <SectionGroup title="集成与运行环境">
                  <HookServerSection settings={settings} update={update} />
                  <ExternalToolsSection settings={settings} update={update} />
                  <ExperimentalSection settings={settings} update={update} />
                </SectionGroup>

                <SectionGroup title="跨工具协作（MCP）">
                  <AgentDeckMcpSection settings={settings} update={update} />
                </SectionGroup>
              </>
            )}

            {activeTab === 'claude' && (
              <SectionGroup title="Claude Code 专属配置">
                <HookSection
                  hookStatus={hookStatus}
                  busy={busy}
                  installHook={installHook}
                  uninstallHook={uninstallHook}
                />
                <div className="text-[10px] leading-snug text-deck-muted/70">
                  Claude 端 MCP servers 由 user 直接编辑
                  <code className="ml-1 rounded bg-white/5 px-1">~/.claude/settings.json</code>
                  (或 project-level
                  <code className="ml-1 rounded bg-white/5 px-1">.mcp.json</code>
                  ),应用层不代写避免与 CLI 外部改动冲突。Agent Deck 自身 MCP server 走通用
                  tab「跨工具协作」段配置。
                </div>
              </SectionGroup>
            )}

            {activeTab === 'codex' && (
              <SectionGroup title="Codex CLI 专属配置">
                <div className="text-[10px] leading-snug text-deck-muted/70">
                  Codex 端配置(model / sandbox / approval / MCP servers / agents
                  registry 等)由 user 直接编辑
                  <code className="ml-1 rounded bg-white/5 px-1">~/.codex/config.toml</code>
                  +
                  <code className="ml-1 rounded bg-white/5 px-1">~/.codex/AGENTS.md</code>
                  (应用 build-time installer 把
                  <code className="ml-1 rounded bg-white/5 px-1">resources/codex-config/CODEX_AGENTS.md</code>
                  marker 包裹段同步进 AGENTS.md)。应用层目前无 codex 专属 settings 字段
                  —— summary / hand-off model 等通用 codex 字段(
                  <code className="rounded bg-white/5 px-1">codexSummaryModel</code> /
                  <code className="rounded bg-white/5 px-1">codexHandOffModel</code>)
                  在通用 tab「会话」段「间歇总结」section 一起设。
                  <br />
                  <br />
                  Agent Deck 自身 MCP server 走通用 tab「跨工具协作」段配置(codex SDK 启动时
                  自动通过 HTTP transport + Bearer token 注入
                  <code className="ml-1 rounded bg-white/5 px-1">mcp_servers.agent-deck</code>
                  段)。
                </div>
              </SectionGroup>
            )}
          </>
        )}
      </div>
    </div>
  );
}
