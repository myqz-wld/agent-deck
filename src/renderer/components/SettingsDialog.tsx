import { useEffect, useId, useRef, useState, type JSX } from 'react';
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
import { useModalFocus } from './use-modal-focus';
import { FeishuPreferencesSection } from './settings/FeishuPreferencesSection';
import { useSettingsDialogRead, type RemoteSettingsSource } from './settings/use-settings-dialog-read';
import { HOOK_FAILURE_COPY, type HookAdapterId } from './settings/hook-failure-copy';
import { presentRemoteSettings } from './settings/remote-settings-presentation';
import {
  presentLocalHookStatus,
} from './settings/hook-status-presentation';
import { useInitialAsyncPresentation } from '@renderer/hooks/useDelayedAsyncFallback';
import { remoteHookUnavailableReason } from './settings/remote-settings-availability';

interface Props {
  open: boolean;
  onClose: () => void;
  remote?: RemoteSettingsSource | null;
}

/**
 * Owns settings and Hook status loading, update IPC calls, and section layout.
 * Asset editing remains isolated in AssetsLibraryDialog.
 */
export function SettingsDialog({ open, onClose, remote = null }: Props): JSX.Element | null {
  const titleId = useId();
  const dialogRef = useRef<HTMLDivElement>(null);
  const read = useSettingsDialogRead(open, remote);
  const { setSettings, setHookStatus } = read;
  const settings = read.value?.settings ?? null;
  const claudeHookStatus = read.value?.hooks['claude-code'] ?? null;
  const codexHookStatus = read.value?.hooks['codex-cli'] ?? null;
  const grokHookStatus = read.value?.hooks['grok-build'] ?? null;
  const nodeConfiguration = read.value?.nodeConfiguration ?? null;
  const loadError = read.value?.loadError ?? null;
  const [busy, setBusy] = useState(false);
  /** Reopen on the general tab so every settings visit starts from the overview. */
  const [activeTab, setActiveTab] = useState<
    'general' | 'claude' | 'codex' | 'grok'
  >('general');
  /** Keep action failures separate from load failures so neither hides the other. */
  const [actionError, setActionError] = useState<string | null>(null);
  /** Ignore stale update responses when multiple controls change in quick succession. */
  const updateSeqRef = useRef(0);
  const remoteAuthorityKey = read.authorityKey;
  const remoteAuthorityRef = useRef(remoteAuthorityKey);
  remoteAuthorityRef.current = remoteAuthorityKey;
  const initialPresentation = useInitialAsyncPresentation(
    open && settings === null && loadError === null,
    `${remoteAuthorityKey}:${open ? 'open' : 'closed'}:settings`,
  );

  useEffect(() => {
    updateSeqRef.current += 1;
    setActionError(null);
    setBusy(false);
    if (open) setActiveTab('general');
  }, [open, remoteAuthorityKey]);

  useModalFocus({ blocked: busy, dialogRef, onClose, open });

  if (!open) return null;

  const update = async (patch: Partial<AppSettings>): Promise<void> => {
    const seq = ++updateSeqRef.current;
    const authority = remoteAuthorityKey;
    setBusy(true);
    setActionError(null);
    try {
      const next = await window.api.setSettings(patch);
      if (seq !== updateSeqRef.current || remoteAuthorityRef.current !== authority) return;
      setSettings(next);
    } catch {
      if (seq !== updateSeqRef.current || remoteAuthorityRef.current !== authority) return;
      setActionError('保存设置失败，请重试。');
    } finally {
      if (seq === updateSeqRef.current && remoteAuthorityRef.current === authority) setBusy(false);
    }
  };

  const installHook = async (adapterId: HookAdapterId): Promise<void> => {
    if (remote) return;
    const seq = ++updateSeqRef.current;
    const authority = remoteAuthorityKey;
    setBusy(true);
    setActionError(null);
    try {
      const r = presentLocalHookStatus(
        (await window.api.installHook('user', undefined, adapterId)) as HookInstallStatus,
      );
      if (seq !== updateSeqRef.current || remoteAuthorityRef.current !== authority) return;
      setHookStatus(adapterId, r);
    } catch {
      if (seq !== updateSeqRef.current || remoteAuthorityRef.current !== authority) return;
      setActionError(HOOK_FAILURE_COPY[adapterId].install);
    } finally {
      if (seq === updateSeqRef.current && remoteAuthorityRef.current === authority) setBusy(false);
    }
  };
  const uninstallHook = async (adapterId: HookAdapterId): Promise<void> => {
    if (remote) return;
    const seq = ++updateSeqRef.current;
    const authority = remoteAuthorityKey;
    setBusy(true);
    setActionError(null);
    try {
      const r = presentLocalHookStatus(
        (await window.api.uninstallHook('user', undefined, adapterId)) as HookInstallStatus,
      );
      if (seq !== updateSeqRef.current || remoteAuthorityRef.current !== authority) return;
      setHookStatus(adapterId, r);
    } catch {
      if (seq !== updateSeqRef.current || remoteAuthorityRef.current !== authority) return;
      setActionError(HOOK_FAILURE_COPY[adapterId].uninstall);
    } finally {
      if (seq === updateSeqRef.current && remoteAuthorityRef.current === authority) setBusy(false);
    }
  };
  const visibleSettings: AppSettings = settings && remote && nodeConfiguration
    ? presentRemoteSettings(settings, nodeConfiguration)
    : settings ?? DEFAULT_SETTINGS;
  const remoteSettingsReady = !remote || nodeConfiguration !== null;

  return (
    <div className="absolute inset-0 z-40 flex items-center justify-center bg-black/50 backdrop-blur-sm">
      <div
        ref={dialogRef}
        tabIndex={-1}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        className="deck-dialog-surface no-drag w-[min(28rem,92vw)] max-h-[85%] overflow-y-auto scrollbar-deck p-4"
      >
        <header className="mb-3 flex items-center justify-between">
          <h2 id={titleId} className="text-[13px] font-medium">
            {remote ? `远端设置 · ${remote.label}` : '设置'}
          </h2>
          <button
            type="button"
            onClick={onClose}
            disabled={busy}
            aria-label="关闭设置"
            className="flex h-5 w-5 items-center justify-center rounded text-[11px] text-deck-muted hover:bg-white/10 disabled:cursor-not-allowed disabled:opacity-40"
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
          initialPresentation === 'fallback'
            ? <div role="status" className="py-6 text-center text-[11px] text-deck-muted">读取设置中…</div>
            : <div className="min-h-12" aria-hidden="true" />
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
                  className={`no-drag min-w-0 flex-1 whitespace-nowrap rounded px-1.5 py-1 text-[11px] transition-colors ${
                    activeTab === tab.id
                      ? 'bg-white/15 text-deck-text'
                      : 'text-deck-muted hover:bg-white/5 hover:text-deck-text'
                  }`}
                >
                  {tab.label}
                </button>
              ))}
            </nav>

            {remote && (
              <div className="mb-3 rounded border border-deck-border/70 bg-white/[0.025] px-2 py-1.5 text-[10px] leading-relaxed text-deck-muted/75">
                远端运行设置仅供查看，飞书模型选择可在下方管理。提醒、窗口和日志仍可修改；快捷键显示本机按键。
              </div>
            )}

            {activeTab === 'general' && (
              <>
                {remote && (
                  <SectionGroup title="飞书机器人">
                    <FeishuPreferencesSection source={remote} managed={read.feishu} />
                  </SectionGroup>
                )}
                {remote && remoteConfigurationStatus(remote)}

                <SectionGroup title="会话">
                  {remoteSettingsReady && (
                    <>
                      <LifecycleSection
                        settings={visibleSettings}
                        update={update}
                        readOnly={Boolean(remote)}
                      />
                      <ContinuationContextSection
                        settings={visibleSettings}
                        update={update}
                        readOnly={Boolean(remote)}
                      />
                      <SummarySection
                        settings={visibleSettings}
                        update={update}
                        readOnly={Boolean(remote)}
                      />
                    </>
                  )}
                </SectionGroup>

                <SectionGroup title="提醒与外观">
                  <NotifySection settings={settings} update={update} />
                  <WindowSection settings={settings} update={update} />
                  <KeyboardShortcutsSection />
                </SectionGroup>

                <SectionGroup title="集成与运行环境">
                  {remoteSettingsReady && (
                    <>
                      <HookServerSection
                        settings={visibleSettings}
                        update={update}
                        readOnly={Boolean(remote)}
                        remoteManaged={Boolean(remote)}
                      />
                      <ExternalToolsSection
                        settings={visibleSettings}
                        update={update}
                        readOnly={Boolean(remote)}
                      />
                      <ExperimentalSection
                        settings={visibleSettings}
                        update={update}
                        readOnly={Boolean(remote)}
                      />
                    </>
                  )}
                  <LogsSection settings={settings} update={update} />
                </SectionGroup>

                <SectionGroup title="跨工具协作（MCP）">
                  {remoteSettingsReady && (
                    <AgentDeckMcpSection
                      settings={visibleSettings}
                      update={update}
                      readOnly={Boolean(remote)}
                    />
                  )}
                </SectionGroup>

                <ResetSettingsButton busy={busy} disabled={Boolean(remote)} update={update} />
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
                  unavailableReason={remote ? remoteHookUnavailableReason(remote) : null}
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
                  unavailableReason={remote ? remoteHookUnavailableReason(remote) : null}
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
                  unavailableReason={remote ? remoteHookUnavailableReason(remote) : null}
                />
                <GrokAuthenticationSection readOnly={Boolean(remote)} />
                <AdapterConfigHelp adapter="grok" />
              </SectionGroup>
            )}
          </>
        )}
      </div>
    </div>
  );
}

function remoteConfigurationUnavailableReason(remote: NonNullable<Props['remote']>): string | null {
  if (!remote.usable) return '当前远端环境尚未连接，暂时无法读取设置。';
  if (!remote.supportsNodeConfiguration) {
    return '当前远端版本不支持读取设置，请升级后重试。';
  }
  if (!remote.profileId) return '当前远端连接信息不完整。';
  return null;
}

function remoteConfigurationStatus(
  remote: NonNullable<Props['remote']>,
): JSX.Element | null {
  const unavailableReason = remoteConfigurationUnavailableReason(remote);
  const message = unavailableReason;
  if (!message) return null;
  return (
    <div role="status" className="mb-3 text-[11px] text-deck-muted">
      {message}
    </div>
  );
}
