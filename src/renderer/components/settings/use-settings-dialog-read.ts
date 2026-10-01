import { useCallback, useEffect, useRef, useState } from 'react';
import { DEFAULT_SETTINGS, type AppSettings, type HookInstallStatus } from '@shared/types';
import type { NodeConfigurationGetResult } from '@contracts/index';
import { RemoteReadCache } from '@shared/remote-read-cache';
import { HOOK_FAILURE_COPY, type HookAdapterId } from './hook-failure-copy';
import { presentLocalHookStatus, presentRemoteHookStatus } from './hook-status-presentation';
import type { HookStatusPresentation } from './sections/HookSection';
import { feishuPreferencesCache, feishuPreferencesKey, readFeishuPreferences,
  type FeishuPreferencesSnapshot, type FeishuPreferencesSource } from './feishu-preferences-data';

export interface RemoteSettingsSource extends FeishuPreferencesSource {
  label: string;
  supportsNodeConfiguration: boolean;
  supportsNodeHooksRead: boolean;
}
interface SettingsSnapshot {
  settings: AppSettings;
  hooks: Record<HookAdapterId, HookStatusPresentation | null>;
  nodeConfiguration: NodeConfigurationGetResult | null;
  nodeConfigurationFailed: boolean;
  loadError: string | null;
  feishu: { snapshot: FeishuPreferencesSnapshot | null; error: string | null };
}
const cache = new RemoteReadCache<SettingsSnapshot>(8);
const adapters = Object.keys(HOOK_FAILURE_COPY) as HookAdapterId[];

async function readSettings(remote: RemoteSettingsSource | null, previous: SettingsSnapshot | null): Promise<SettingsSnapshot> {
  const errors: string[] = [];
  const node = remote?.usable && remote.profileId && remote.supportsNodeConfiguration
    ? window.api.getRemoteHostNodeConfiguration({ profileId: remote.profileId }) : Promise.resolve(null);
  const hooks = adapters.map(async adapterId => {
    if (!remote) return presentLocalHookStatus(await window.api.hookStatus('user', undefined, adapterId) as HookInstallStatus);
    if (!remote.usable || !remote.profileId || !remote.supportsNodeHooksRead) return null;
    const result = await window.api.getRemoteHostNodeHookStatus({ profileId: remote.profileId, adapterId });
    if (result.adapterId !== adapterId) throw new Error('Hook adapter mismatch');
    return presentRemoteHookStatus(result.status);
  });
  const feishu = remote?.usable && remote.profileId && remote.supportsFeishuPreferences && remote.expectedAuthority
    ? readFeishuPreferences(remote) : Promise.resolve(null);
  const [settingsResult, nodeResult, feishuResult, ...hookResults] = await Promise.allSettled([
    window.api.getSettings(), node, feishu, ...hooks,
  ] as const);
  const settings = settingsResult.status === 'fulfilled' ? settingsResult.value : previous?.settings ?? { ...DEFAULT_SETTINGS };
  if (settingsResult.status === 'rejected') errors.push(remote ? '本机桌面外观与提醒设置读取失败，请重试。' : '设置读取失败，请重试。');
  if (nodeResult.status === 'rejected') errors.push('远端设置读取失败，请重新打开后重试。');
  const nextHooks = Object.fromEntries(adapters.map((adapter, index) => {
    const result = hookResults[index];
    if (result.status === 'rejected') errors.push(HOOK_FAILURE_COPY[adapter].status);
    return [adapter, result.status === 'fulfilled' ? result.value : previous?.hooks[adapter] ?? null];
  })) as SettingsSnapshot['hooks'];
  return {
    settings, hooks: nextHooks,
    nodeConfiguration: nodeResult.status === 'fulfilled' ? nodeResult.value : previous?.nodeConfiguration ?? null,
    nodeConfigurationFailed: nodeResult.status === 'rejected',
    loadError: errors.length ? errors.join('\n') : null,
    feishu: { snapshot: feishuResult.status === 'fulfilled' ? feishuResult.value : previous?.feishu.snapshot ?? null,
      error: feishuResult.status === 'rejected' ? '读取机器人配置失败。' : null },
  };
}

export function useSettingsDialogRead(open: boolean, remote: RemoteSettingsSource | null) {
  const authorityKey = remote ? JSON.stringify([remote.identity, remote.profileId, remote.usable,
    remote.supportsNodeConfiguration, remote.supportsNodeHooksRead, remote.supportsFeishuPreferences, remote.expectedAuthority]) : 'local';
  const cycle = useRef({ key: '', number: 0 });
  const readKey = `${authorityKey}:${open}`;
  if (cycle.current.key !== readKey) cycle.current = { key: readKey, number: cycle.current.number + 1 };
  const readCycle = cycle.current.number;
  const [state, setState] = useState<{ key: string; cycle: number; value: SettingsSnapshot | null; pending: boolean }>(() => ({
    key: authorityKey, cycle: -1, value: remote?.usable ? cache.get(authorityKey) : null, pending: true,
  }));
  const remoteRef = useRef(remote);
  remoteRef.current = remote;
  const currentKey = useRef(authorityKey);
  currentKey.current = authorityKey;
  const mutationEpoch = useRef(0);
  const value = state.key === authorityKey ? state.value : remote?.usable ? cache.get(authorityKey) : null;
  const pending = open && (state.cycle !== readCycle || state.pending);
  useEffect(() => {
    if (remoteRef.current && !remoteRef.current.usable) { cache.clear(); feishuPreferencesCache.clear(); }
    if (!open) return;
    let cancelled = false;
    const startedEpoch = mutationEpoch.current;
    const cached = remoteRef.current?.usable ? cache.get(authorityKey) : null;
    setState(current => ({ key: authorityKey, cycle: readCycle,
      value: current.key === authorityKey ? current.value : cached, pending: true }));
    void readSettings(remoteRef.current, cached).then(next => {
      if (cancelled) return;
      setState(current => {
        const accepted = current.key === authorityKey && current.value && startedEpoch !== mutationEpoch.current
          ? { ...next, settings: current.value.settings, hooks: current.value.hooks } : next;
        if (remoteRef.current?.usable && !accepted.loadError && !accepted.feishu.error) cache.set(authorityKey, accepted);
        return { key: authorityKey, cycle: readCycle, value: accepted, pending: false };
      });
    }).catch(() => {
      if (cancelled) return;
      const previous = cached ?? { settings: { ...DEFAULT_SETTINGS },
        hooks: { 'claude-code': null, 'codex-cli': null, 'grok-build': null },
        nodeConfiguration: null, nodeConfigurationFailed: true, feishu: { snapshot: null, error: null } };
      setState({ key: authorityKey, cycle: readCycle,
        value: { ...previous, loadError: '设置读取失败，请重新打开后重试。' }, pending: false });
    });
    return () => { cancelled = true; };
  }, [open, authorityKey, readCycle]);

  const update = useCallback((change: (current: SettingsSnapshot) => SettingsSnapshot) => {
    mutationEpoch.current += 1;
    setState(current => {
      if (!current.value || current.key !== currentKey.current) return current;
      const next = change(current.value);
      if (remoteRef.current?.usable) cache.set(current.key, next);
      return { ...current, value: next };
    });
  }, []);
  const setSettings = useCallback((settings: AppSettings) => update(current => ({ ...current, settings })), [update]);
  const setHookStatus = useCallback((adapter: HookAdapterId, status: HookStatusPresentation) =>
    update(current => ({ ...current, hooks: { ...current.hooks, [adapter]: status } })), [update]);
  const cachedFeishu = remote?.usable ? feishuPreferencesCache.get(feishuPreferencesKey(remote)) : null;
  const feishu = value?.feishu;
  return { authorityKey, pending, value, setSettings, setHookStatus,
    feishu: { snapshot: cachedFeishu && cachedFeishu.settings.settingsRevision > (feishu?.snapshot?.settings.settingsRevision ?? -1)
      ? cachedFeishu : feishu?.snapshot ?? null, error: feishu?.error ?? null, pending },
  };
}
