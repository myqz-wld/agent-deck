import { useEffect, useRef, useState, type JSX } from 'react';
import { CloseIcon } from './icons';
import { DEFAULT_SETTINGS, type AppSettings, type HookInstallStatus } from '@shared/types';
import { SectionGroup } from './settings/controls';
import { HookSection } from './settings/sections/HookSection';
import { NotifySection } from './settings/sections/NotifySection';
import { LifecycleSection } from './settings/sections/LifecycleSection';
import { ContinuationContextSection } from './settings/sections/ContinuationContextSection';
import { SummarySection } from './settings/sections/SummarySection';
import { WindowSection } from './settings/sections/WindowSection';
import { KeyboardShortcutsSection } from './settings/sections/KeyboardShortcutsSection';
import { HookServerSection } from './settings/sections/HookServerSection';
import { ExternalToolsSection } from './settings/sections/ExternalToolsSection';
import { ExperimentalSection } from './settings/sections/ExperimentalSection';
import { AgentDeckMcpSection } from './settings/sections/AgentDeckMcpSection';
import { GrokAuthenticationSection } from './settings/sections/GrokAuthenticationSection';
import { LogsSection } from './settings/sections/LogsSection';
import { AdapterConfigHelp } from './settings/AdapterConfigHelp';
import { ResetSettingsButton } from './settings/ResetSettingsButton';

interface Props {
  open: boolean;
  onClose: () => void;
}

const HOOK_FAILURE_COPY = {
  'claude-code': {
    status: 'Claude Code 终端 Hook 状态读取失败，请重试。',
    install: 'Claude Code 终端 Hook 安装失败，请重试。',
    uninstall: 'Claude Code 终端 Hook 卸载失败，请重试。',
  },
  'codex-cli': {
    status: 'Codex CLI 终端 Hook 状态读取失败，请重试。',
    install: 'Codex CLI 终端 Hook 安装失败，请重试。',
    uninstall: 'Codex CLI 终端 Hook 卸载失败，请重试。',
  },
  'grok-build': {
    status: 'Grok Build 终端 Hook 状态读取失败，请重试。',
    install: 'Grok Build 终端 Hook 安装失败，请重试。',
    uninstall: 'Grok Build 终端 Hook 卸载失败，请重试。',
  },
} as const;

type HookAdapterId = keyof typeof HOOK_FAILURE_COPY;

/**
 * Owns settings and Hook status loading, update IPC calls, and section layout.
 * Asset editing remains isolated in AssetsLibraryDialog.
 */
export function SettingsDialog({ open, onClose }: Props): JSX.Element | null {
  const [settings, setSettings] = useState<AppSettings | null>(null);
  const [claudeHookStatus, setClaudeHookStatus] = useState<HookInstallStatus | null>(null);
  const [codexHookStatus, setCodexHookStatus] = useState<HookInstallStatus | null>(null);
  const [grokHookStatus, setGrokHookStatus] = useState<HookInstallStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  /** Reopen on the general tab so every settings visit starts from the overview. */
  const [activeTab, setActiveTab] = useState<
    'general' | 'claude' | 'codex' | 'grok'
  >('general');
  /** Keep action failures separate from load failures so neither hides the other. */
  const [actionError, setActionError] = useState<string | null>(null);
  /** Ignore responses from an earlier open cycle. */
  const openSeqRef = useRef(0);
  /** Ignore stale update responses when multiple controls change in quick succession. */
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
        if (seq !== openSeqRef.current) return;
        setSettings(s);
      })
      .catch(() => {
        if (seq !== openSeqRef.current) return;
        setLoadError('设置读取失败，请重试。');
        // A read failure still leaves the complete default form available for recovery.
        setSettings((prev) => prev ?? { ...DEFAULT_SETTINGS });
      });
    void window.api
      .hookStatus('user', undefined, 'claude-code')
      .then((s) => {
        if (seq !== openSeqRef.current) return;
        setClaudeHookStatus(s as HookInstallStatus);
      })
      .catch(() => {
        if (seq !== openSeqRef.current) return;
        setLoadError(
          (prev) =>
            (prev ? prev + '\n' : '') +
            HOOK_FAILURE_COPY['claude-code'].status,
        );
      });
    void window.api
      .hookStatus('user', undefined, 'codex-cli')
      .then((s) => {
        if (seq !== openSeqRef.current) return;
        setCodexHookStatus(s as HookInstallStatus);
      })
      .catch(() => {
        if (seq !== openSeqRef.current) return;
        setLoadError(
          (prev) =>
            (prev ? prev + '\n' : '') +
            HOOK_FAILURE_COPY['codex-cli'].status,
        );
      });
    void window.api
      .hookStatus('user', undefined, 'grok-build')
      .then((s) => {
        if (seq !== openSeqRef.current) return;
        setGrokHookStatus(s as HookInstallStatus);
      })
      .catch(() => {
        if (seq !== openSeqRef.current) return;
        setLoadError(
          (prev) =>
            (prev ? prev + '\n' : '') +
            HOOK_FAILURE_COPY['grok-build'].status,
        );
      });
  }, [open]);

  if (!open) return null;

  const update = async (patch: Partial<AppSettings>): Promise<void> => {
    const seq = ++updateSeqRef.current;
    setBusy(true);
    setActionError(null);
    try {
      const next = await window.api.setSettings(patch);
      if (seq !== updateSeqRef.current) return;
      setSettings(next);
    } catch {
      if (seq !== updateSeqRef.current) return;
      setActionError('保存设置失败，请重试。');
    } finally {
      if (seq === updateSeqRef.current) setBusy(false);
    }
  };

  const setHookStatus = (adapterId: HookAdapterId, status: HookInstallStatus): void => {
    if (adapterId === 'claude-code') setClaudeHookStatus(status);
    else if (adapterId === 'codex-cli') setCodexHookStatus(status);
    else setGrokHookStatus(status);
  };
  const installHook = async (adapterId: HookAdapterId): Promise<void> => {
    setBusy(true);
    setActionError(null);
    try {
      const r = (await window.api.installHook('user', undefined, adapterId)) as HookInstallStatus;
      setHookStatus(adapterId, r);
    } catch {
      setActionError(HOOK_FAILURE_COPY[adapterId].install);
    } finally {
      setBusy(false);
    }
  };
  const uninstallHook = async (adapterId: HookAdapterId): Promise<void> => {
    setBusy(true);
    setActionError(null);
    try {
      const r = (await window.api.uninstallHook('user', undefined, adapterId)) as HookInstallStatus;
      setHookStatus(adapterId, r);
    } catch {
      setActionError(HOOK_FAILURE_COPY[adapterId].uninstall);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="absolute inset-0 z-40 flex items-center justify-center bg-black/40 backdrop-blur-sm">
      <div className="no-drag w-[380px] max-h-[85%] overflow-y-auto scrollbar-deck rounded-xl border border-deck-border bg-deck-bg-strong p-4 shadow-2xl">
        <header className="mb-3 flex items-center justify-between">
          <h2 className="text-[13px] font-medium">设置</h2>
          <button
            type="button"
            onClick={onClose}
            aria-label="关闭设置"
            className="flex h-5 w-5 items-center justify-center rounded text-[11px] text-deck-muted hover:bg-white/10"
          >
            <CloseIcon className="h-3.5 w-3.5" />
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
              aria-label="切换设置分类"
              className="mb-3 flex gap-0.5 rounded-md border border-deck-border bg-white/[0.02] p-0.5"
            >
              {(
                [
                  { id: 'general', label: '通用' },
                  { id: 'claude', label: 'Claude Code' },
                  { id: 'codex', label: 'Codex CLI' },
                  { id: 'grok', label: 'Grok Build' },
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
                  <ContinuationContextSection settings={settings} update={update} />
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

                <SectionGroup title="跨工具协作（MCP）">
                  <AgentDeckMcpSection settings={settings} update={update} />
                </SectionGroup>

                <ResetSettingsButton busy={busy} update={update} />
              </>
            )}

            {activeTab === 'claude' && (
              <SectionGroup title="Claude Code 配置">
                <HookSection
                  title="Claude Code 终端 Hook"
                  storageKey="hook-claude"
                  installLabel="安装到 ~/.claude/settings.json"
                  hookStatus={claudeHookStatus}
                  busy={busy}
                  installHook={() => installHook('claude-code')}
                  uninstallHook={() => uninstallHook('claude-code')}
                />
                <AdapterConfigHelp adapter="claude" />
              </SectionGroup>
            )}

            {activeTab === 'codex' && (
              <SectionGroup title="Codex CLI 配置">
                <HookSection
                  title="Codex CLI 终端 Hook"
                  storageKey="hook-codex"
                  installLabel="安装到 ~/.codex/hooks.json"
                  hookStatus={codexHookStatus}
                  busy={busy}
                  installHook={() => installHook('codex-cli')}
                  uninstallHook={() => uninstallHook('codex-cli')}
                />
                <AdapterConfigHelp adapter="codex" />
              </SectionGroup>
            )}

            {activeTab === 'grok' && (
              <SectionGroup title="Grok Build 配置">
                <HookSection
                  title="Grok Build 终端 Hook"
                  storageKey="hook-grok"
                  installLabel="安装到 ~/.grok/hooks/agent-deck.json"
                  hookStatus={grokHookStatus}
                  busy={busy}
                  installHook={() => installHook('grok-build')}
                  uninstallHook={() => uninstallHook('grok-build')}
                />
                <GrokAuthenticationSection />
                <AdapterConfigHelp adapter="grok" />
              </SectionGroup>
            )}
          </>
        )}
      </div>
    </div>
  );
}
