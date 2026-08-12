import { useEffect, useId, useRef, useState, type JSX } from 'react';
import { CloseIcon } from './icons';
import { DEFAULT_SETTINGS, type AppSettings, type HookInstallStatus } from '@shared/types';
import { SectionGroup } from './settings/controls';
import {
  HookSection,
  type HookStatusPresentation,
} from './settings/sections/HookSection';
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
import { RemoteNodeConfigurationSection } from './settings/sections/RemoteNodeConfigurationSection';
import type { NodeConfigurationGetResult } from '@contracts/index';
import type { RemoteHostMutationAuthorityDto } from '@shared/remote-host';
import {
  presentLocalHookStatus,
  presentRemoteHookResult,
  presentRemoteHookStatus,
} from './settings/hook-status-presentation';

interface Props {
  open: boolean;
  onClose: () => void;
  remote?: {
    identity: string;
    expectedAuthority: RemoteHostMutationAuthorityDto;
    label: string;
    profileId: string | null;
    supportsNodeConfiguration: boolean;
    supportsNodeHooksRead: boolean;
    supportsNodeHooksWrite: boolean;
    usable: boolean;
  } | null;
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
export function SettingsDialog({ open, onClose, remote = null }: Props): JSX.Element | null {
  const titleId = useId();
  const dialogRef = useRef<HTMLDivElement>(null);
  const [settings, setSettings] = useState<AppSettings | null>(null);
  const [claudeHookStatus, setClaudeHookStatus] = useState<HookStatusPresentation | null>(null);
  const [codexHookStatus, setCodexHookStatus] = useState<HookStatusPresentation | null>(null);
  const [grokHookStatus, setGrokHookStatus] = useState<HookStatusPresentation | null>(null);
  const [nodeConfiguration, setNodeConfiguration] =
    useState<NodeConfigurationGetResult | null>(null);
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
  const remoteAuthorityKey = remote
    ? `${remote.identity}\u0000${remote.profileId ?? ''}\u0000${remote.usable ? 'ready' : 'offline'}` +
      `\u0000${remote.supportsNodeConfiguration ? 'supported' : 'unsupported'}`
      + `\u0000${remote.supportsNodeHooksRead ? 'hooks-read' : 'hooks-no-read'}`
      + `\u0000${remote.supportsNodeHooksWrite ? 'hooks-write' : 'hooks-read-only'}`
    : 'local';
  const remoteAuthorityRef = useRef(remoteAuthorityKey);
  remoteAuthorityRef.current = remoteAuthorityKey;

  useEffect(() => {
    if (!open) return;
    const seq = ++openSeqRef.current;
    updateSeqRef.current += 1;
    const authority = remoteAuthorityKey;
    const current = (): boolean =>
      seq === openSeqRef.current && remoteAuthorityRef.current === authority;
    setLoadError(null);
    setActionError(null);
    setBusy(false);
    setActiveTab('general');
    setClaudeHookStatus(null);
    setCodexHookStatus(null);
    setGrokHookStatus(null);
    setNodeConfiguration(null);
    void window.api
      .getSettings()
      .then((s) => {
        if (!current()) return;
        setSettings(s);
      })
      .catch(() => {
        if (!current()) return;
        setLoadError(remote
          ? '本机桌面外观与提醒设置读取失败，请重试。'
          : '设置读取失败，请重试。');
        // A read failure still leaves the complete default form available for recovery.
        setSettings((prev) => prev ?? { ...DEFAULT_SETTINGS });
      });
    const appendLoadError = (message: string): void => {
      if (!current()) return;
      setLoadError((prev) => (prev ? `${prev}\n${message}` : message));
    };
    const setStatus = (adapterId: HookAdapterId, status: HookStatusPresentation): void => {
      if (!current()) return;
      if (adapterId === 'claude-code') setClaudeHookStatus(status);
      else if (adapterId === 'codex-cli') setCodexHookStatus(status);
      else setGrokHookStatus(status);
    };
    if (remote) {
      if (remote.usable && remote.profileId) {
        if (remote.supportsNodeConfiguration) {
          void window.api.getRemoteHostNodeConfiguration({ profileId: remote.profileId })
            .then((value) => {
              if (current()) setNodeConfiguration(value);
            })
            .catch(() => appendLoadError('远端执行节点配置读取失败，请重连后重试。'));
        }
        if (remote.supportsNodeHooksRead) {
          for (const adapterId of Object.keys(HOOK_FAILURE_COPY) as HookAdapterId[]) {
            void window.api.getRemoteHostNodeHookStatus({
              profileId: remote.profileId,
              adapterId,
            }).then((value) => {
              if (value.adapterId !== adapterId) {
                appendLoadError(HOOK_FAILURE_COPY[adapterId].status);
                return;
              }
              setStatus(
                adapterId,
                presentRemoteHookStatus(value.status, remote.supportsNodeHooksWrite),
              );
            }).catch(() => appendLoadError(HOOK_FAILURE_COPY[adapterId].status));
          }
        }
      }
    } else {
      for (const adapterId of Object.keys(HOOK_FAILURE_COPY) as HookAdapterId[]) {
        void window.api.hookStatus('user', undefined, adapterId)
          .then((value) => setStatus(
            adapterId,
            presentLocalHookStatus(value as HookInstallStatus),
          ))
          .catch(() => appendLoadError(HOOK_FAILURE_COPY[adapterId].status));
      }
    }
  }, [
    open,
    remote?.identity,
    remote?.profileId,
    remote?.supportsNodeConfiguration,
    remote?.supportsNodeHooksRead,
    remote?.supportsNodeHooksWrite,
    remote?.usable,
  ]);

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

  const setHookStatus = (adapterId: HookAdapterId, status: HookStatusPresentation): void => {
    if (adapterId === 'claude-code') setClaudeHookStatus(status);
    else if (adapterId === 'codex-cli') setCodexHookStatus(status);
    else setGrokHookStatus(status);
  };
  const installHook = async (adapterId: HookAdapterId): Promise<void> => {
    const seq = ++updateSeqRef.current;
    const authority = remoteAuthorityKey;
    setBusy(true);
    setActionError(null);
    try {
      const r = remote
        ? await installRemoteHook(remote, adapterId)
        : presentLocalHookStatus(
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
    const seq = ++updateSeqRef.current;
    const authority = remoteAuthorityKey;
    setBusy(true);
    setActionError(null);
    try {
      const r = remote
        ? await uninstallRemoteHook(remote, adapterId)
        : presentLocalHookStatus(
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

  return (
    <div className="absolute inset-0 z-40 flex items-center justify-center bg-black/40 backdrop-blur-sm">
      <div
        ref={dialogRef}
        tabIndex={-1}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        className="no-drag w-[min(26rem,92vw)] max-h-[85%] overflow-y-auto scrollbar-deck rounded-xl border border-deck-border bg-deck-bg-strong p-4 shadow-2xl"
      >
        <header className="mb-3 flex items-center justify-between">
          <h2 id={titleId} className="text-[13px] font-medium">
            设置{remote ? ` · ${remote.label}` : ''}
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

            {activeTab === 'general' && (
              <>
                {remote ? (
                  <>
                    <RemoteNodeConfigurationSection
                      configuration={nodeConfiguration}
                      unavailableReason={remoteConfigurationUnavailableReason(remote)}
                    />
                    <SectionGroup title="本机桌面（不影响 Worker）">
                      <NotifySection settings={settings} update={update} />
                      <WindowSection settings={settings} update={update} />
                      <KeyboardShortcutsSection />
                      <LogsSection settings={settings} update={update} />
                    </SectionGroup>
                  </>
                ) : (
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
              </>
            )}

            {activeTab === 'claude' && (
              <SectionGroup title="Claude Code 配置">
                <HookSection
                  title="Claude Code 终端 Hook"
                  storageKey="hook-claude"
                  installLabel={remote ? '在 Worker 上安装 Hook' : '安装到 ~/.claude/settings.json'}
                  hookStatus={claudeHookStatus}
                  busy={busy}
                  installHook={() => installHook('claude-code')}
                  uninstallHook={() => uninstallHook('claude-code')}
                  targetDescription={remote ? '作用目标：当前 Remote Worker 的 Claude Code Provider Home。' : undefined}
                  unavailableReason={remote ? remoteHookUnavailableReason(remote) : null}
                />
                {remote ? <RemoteAdapterNote /> : <AdapterConfigHelp adapter="claude" />}
              </SectionGroup>
            )}

            {activeTab === 'codex' && (
              <SectionGroup title="Codex CLI 配置">
                <HookSection
                  title="Codex CLI 终端 Hook"
                  storageKey="hook-codex"
                  installLabel={remote ? '在 Worker 上安装 Hook' : '安装到 ~/.codex/hooks.json'}
                  hookStatus={codexHookStatus}
                  busy={busy}
                  installHook={() => installHook('codex-cli')}
                  uninstallHook={() => uninstallHook('codex-cli')}
                  targetDescription={remote ? '作用目标：当前 Remote Worker 的 Codex CLI Provider Home。' : undefined}
                  unavailableReason={remote ? remoteHookUnavailableReason(remote) : null}
                />
                {remote ? <RemoteAdapterNote /> : <AdapterConfigHelp adapter="codex" />}
              </SectionGroup>
            )}

            {activeTab === 'grok' && (
              <SectionGroup title="Grok Build 配置">
                <HookSection
                  title="Grok Build 终端 Hook"
                  storageKey="hook-grok"
                  installLabel={remote ? '在 Worker 上安装 Hook' : '安装到 ~/.grok/hooks/agent-deck.json'}
                  hookStatus={grokHookStatus}
                  busy={busy}
                  installHook={() => installHook('grok-build')}
                  uninstallHook={() => uninstallHook('grok-build')}
                  targetDescription={remote ? '作用目标：当前 Remote Worker 的 Grok Build Provider Home。' : undefined}
                  unavailableReason={remote ? remoteHookUnavailableReason(remote) : null}
                />
                {!remote && <GrokAuthenticationSection />}
                {remote ? <RemoteAdapterNote /> : <AdapterConfigHelp adapter="grok" />}
              </SectionGroup>
            )}
          </>
        )}
      </div>
    </div>
  );
}

function remoteConfigurationUnavailableReason(remote: NonNullable<Props['remote']>): string | null {
  if (!remote.usable) return '当前 Remote Worker 尚未连接；不会读取或修改本机 Hook 作为替代。';
  if (!remote.supportsNodeConfiguration) {
    return '当前 Remote Core 版本未提供节点配置能力；请先升级远端部署。';
  }
  if (!remote.profileId) return '当前没有可寻址的 Remote profile。';
  return null;
}

function remoteHookUnavailableReason(remote: NonNullable<Props['remote']>): string | null {
  if (!remote.usable) return '当前 Remote Worker 尚未连接；不会读取或修改本机 Hook 作为替代。';
  if (!remote.supportsNodeHooksRead) {
    return '当前 Remote Core 未提供安全 Hook 状态能力；不会读取旧版路径型状态。';
  }
  if (!remote.profileId) return '当前没有可寻址的 Remote profile。';
  return null;
}

async function installRemoteHook(
  remote: NonNullable<Props['remote']>,
  adapterId: HookAdapterId,
): Promise<HookStatusPresentation> {
  const reason = remoteHookUnavailableReason(remote);
  if (!reason && !remote.supportsNodeHooksWrite) {
    throw new Error('Remote Hook mutation unavailable');
  }
  if (reason || !remote.profileId) throw new Error(reason ?? 'Remote profile unavailable');
  const result = await window.api.installRemoteHostNodeHook({
    profileId: remote.profileId,
    adapterId,
    expectedAuthority: remote.expectedAuthority,
    intentId: crypto.randomUUID(),
  });
  return presentRemoteHookResult(result, adapterId, remote.supportsNodeHooksWrite);
}

async function uninstallRemoteHook(
  remote: NonNullable<Props['remote']>,
  adapterId: HookAdapterId,
): Promise<HookStatusPresentation> {
  const reason = remoteHookUnavailableReason(remote);
  if (!reason && !remote.supportsNodeHooksWrite) {
    throw new Error('Remote Hook mutation unavailable');
  }
  if (reason || !remote.profileId) throw new Error(reason ?? 'Remote profile unavailable');
  const result = await window.api.uninstallRemoteHostNodeHook({
    profileId: remote.profileId,
    adapterId,
    expectedAuthority: remote.expectedAuthority,
    intentId: crypto.randomUUID(),
  });
  return presentRemoteHookResult(result, adapterId, remote.supportsNodeHooksWrite);
}

function RemoteAdapterNote(): JSX.Element {
  return (
    <p className="text-[10px] leading-relaxed text-deck-muted/75">
      Provider 默认参数显示在“通用”页，数据来自 Worker。二进制路径、认证和托管策略由远端部署管理；本页不会读取或修改本机 Provider 配置。
    </p>
  );
}
