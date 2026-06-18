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
import { LogsSection } from './settings/sections/LogsSection';

interface Props {
  open: boolean;
  onClose: () => void;
}

/**
 * 设置弹窗外壳：负责 settings/hookStatus 加载、update IPC 调用、section 编排。
 *
 * CHANGELOG_69：信息架构重组 ——
 * - 删 3 个「资产注入」section（ClaudeMd / PluginAssets / CodexInjection），资产注入 toggle 整体迁
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
  const [claudeHookStatus, setClaudeHookStatus] = useState<HookInstallStatus | null>(null);
  const [codexHookStatus, setCodexHookStatus] = useState<HookInstallStatus | null>(null);
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
      .hookStatus('user', undefined, 'claude-code')
      .then((s) => {
        if (seq !== openSeqRef.current) return;
        setClaudeHookStatus(s as HookInstallStatus);
      })
      .catch((err: unknown) => {
        if (seq !== openSeqRef.current) return;
        setLoadError(
          (prev) =>
            (prev ? prev + '\n' : '') +
            `Claude hookStatus 失败：${(err as Error).message ?? String(err)}`,
        );
      });
    void window.api
      .hookStatus('user', undefined, 'codex-cli')
      .then((s) => {
        if (seq !== openSeqRef.current) return;
        setCodexHookStatus(s as HookInstallStatus);
      })
      .catch((err: unknown) => {
        if (seq !== openSeqRef.current) return;
        setLoadError(
          (prev) =>
            (prev ? prev + '\n' : '') +
            `Codex hookStatus 失败：${(err as Error).message ?? String(err)}`,
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

  const installHook = async (adapterId: 'claude-code' | 'codex-cli'): Promise<void> => {
    setBusy(true);
    setActionError(null);
    try {
      const r = (await window.api.installHook('user', undefined, adapterId)) as HookInstallStatus;
      if (adapterId === 'codex-cli') setCodexHookStatus(r);
      else setClaudeHookStatus(r);
    } catch (err) {
      setActionError(`安装 hook 失败：${(err as Error).message ?? String(err)}`);
    } finally {
      setBusy(false);
    }
  };
  const uninstallHook = async (adapterId: 'claude-code' | 'codex-cli'): Promise<void> => {
    setBusy(true);
    setActionError(null);
    try {
      const r = (await window.api.uninstallHook('user', undefined, adapterId)) as HookInstallStatus;
      if (adapterId === 'codex-cli') setCodexHookStatus(r);
      else setClaudeHookStatus(r);
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
                  { id: 'claude', label: 'Claude Code' },
                  { id: 'codex', label: 'Codex CLI' },
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
                  <LogsSection settings={settings} update={update} />
                </SectionGroup>

                <SectionGroup title="跨工具协作(MCP)">
                  <AgentDeckMcpSection settings={settings} update={update} />
                </SectionGroup>
              </>
            )}

            {activeTab === 'claude' && (
              <SectionGroup title="Claude Code 专属配置">
                <HookSection
                  title="Claude Code Hook（系统钩子）"
                  storageKey="hook-claude"
                  installLabel="安装到 ~/.claude/settings.json"
                  hookStatus={claudeHookStatus}
                  busy={busy}
                  installHook={() => installHook('claude-code')}
                  uninstallHook={() => uninstallHook('claude-code')}
                />
                <div className="text-[10px] leading-snug text-deck-muted/70">
                  Claude Code 的 MCP 服务在
                  <code className="ml-1 rounded bg-white/5 px-1">~/.claude/settings.json</code>
                  或项目根目录的
                  <code className="ml-1 rounded bg-white/5 px-1">.mcp.json</code>
                  里直接编辑,应用不代写以免和 CLI 改动冲突。Agent Deck 自带的 MCP 服务在「通用 → 跨工具协作」中配置。
                </div>
              </SectionGroup>
            )}

            {activeTab === 'codex' && (
              <SectionGroup title="Codex CLI 专属配置">
                <HookSection
                  title="Codex CLI Hook（系统钩子）"
                  storageKey="hook-codex"
                  installLabel="安装到 ~/.codex/hooks.json"
                  hookStatus={codexHookStatus}
                  busy={busy}
                  installHook={() => installHook('codex-cli')}
                  uninstallHook={() => uninstallHook('codex-cli')}
                />
                <div className="text-[10px] leading-snug text-deck-muted/70">
                  Codex 配置(模型 / 沙盒 / 审批 / MCP 等)在
                  <code className="ml-1 rounded bg-white/5 px-1">~/.codex/config.toml</code>
                  中编辑;外部终端 Codex 会话通过
                  <code className="ml-1 rounded bg-white/5 px-1">~/.codex/hooks.json</code>
                  上报到 Agent Deck。应用内 Codex 会话会通过 thread options 注入 Agent Deck 应用约定和内置 skills。
                  <br />
                  <br />
                  Codex 用的总结 / 接力模型在「通用 → 会话 → 间歇总结」中设置;
                  Agent Deck 自带的 MCP 服务在「通用 → 跨工具协作」中配置(Codex 启动时会自动连接)。
                </div>
              </SectionGroup>
            )}
          </>
        )}
      </div>
    </div>
  );
}
