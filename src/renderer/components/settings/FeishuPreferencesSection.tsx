import { useEffect, useRef, useState, type JSX } from 'react';
import type { FeishuModelPreference, FeishuPreferencesResult, SessionConsoleCapabilitiesResult } from '@contracts/index';
import type { RemoteHostMutationAuthorityDto } from '@shared/remote-host';
import { useDelayedAsyncFallback, useInitialAsyncPresentation } from '@renderer/hooks/useDelayedAsyncFallback';
import { FeishuPreferenceEditor } from './FeishuPreferenceEditor';

export interface FeishuPreferencesSource {
  identity: string;
  profileId: string | null;
  usable: boolean;
  supportsFeishuPreferences?: boolean;
  expectedAuthority?: RemoteHostMutationAuthorityDto;
}

interface Snapshot {
  settings: FeishuPreferencesResult;
  capability: SessionConsoleCapabilitiesResult;
  refresh: number;
}

function ConnectedPreferences({ profileId, source }: { profileId: string; source: FeishuPreferencesSource }): JSX.Element {
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);
  const [refresh, setRefresh] = useState(0);
  const alive = useRef(true);
  const saving = useRef(false);
  const reading = useRef(true);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  useEffect(() => {
    let cancelled = false;
    setError(null);
    setLoading(true);
    reading.current = true;
    void (async () => {
      const settings = await window.api.getRemoteHostFeishuPreferences({ profileId });
      if (cancelled) return;
      const { adapterId, provider } = settings.conversation;
      const capability = await window.api.getRemoteHostSessionCapabilities({ profileId, adapterId,
        provider, workingDirectory: '.' });
      if (!cancelled) setSnapshot({ settings, capability, refresh });
    })().catch(() => {
      if (!cancelled) setError('读取模型配置失败，请刷新后重试。');
    }).finally(() => {
      if (!cancelled) { reading.current = false; setLoading(false); }
    });
    return () => { cancelled = true; };
  }, [profileId, refresh]);
  const initialPresentation = useInitialAsyncPresentation(loading && !snapshot, source.identity);
  const showLoading = useDelayedAsyncFallback(loading, `${source.identity}:${refresh}`);
  const save = async (preference: FeishuModelPreference): Promise<void> => {
    if (!snapshot || saving.current || reading.current || error || !source.expectedAuthority) return;
    saving.current = true;
    setBusy(true);
    try {
      const settings = await window.api.updateRemoteHostFeishuPreferences({ profileId, purpose: 'conversation', preference,
        expectedSettingsRevision: snapshot.settings.settingsRevision, expectedAuthority: source.expectedAuthority,
        intentId: crypto.randomUUID() });
      if (alive.current) setSnapshot(current => current ? { ...current, settings } : null);
    } catch {
      if (alive.current) setError('保存未确认，或配置已在飞书中修改。请刷新核对后再保存。');
    } finally { saving.current = false; if (alive.current) setBusy(false); }
  };
  if (!snapshot && initialPresentation === 'deferred') return <div className="min-h-6" />;
  return <div className="space-y-2">
    {snapshot && <>
      <p className="text-[10px] leading-relaxed text-deck-muted">与飞书同步，用于新开启的机器人聊天。</p>
      <FeishuPreferenceEditor key={snapshot.refresh} profileId={profileId} value={snapshot.settings.conversation}
        initialCapability={snapshot.capability} blocked={busy || loading || Boolean(error)}
        busy={busy || showLoading || Boolean(error)} onSave={save} />
    </>}
    <div className="min-h-4 text-[11px]">
      {error ? <p role="alert" className="text-status-waiting">{error}</p>
        : showLoading ? <p role="status" className="text-deck-muted">正在读取模型配置…</p> : null}
    </div>
    <button type="button" disabled={busy || loading} className="text-[11px] text-deck-muted hover:text-deck-text"
      onClick={() => { reading.current = true; setLoading(true); setRefresh(value => value + 1); }}>刷新配置</button>
  </div>;
}

export function FeishuPreferencesSection({ source }: { source: FeishuPreferencesSource | null }): JSX.Element | null {
  if (!source) return null;
  if (!source.usable || !source.profileId) return <p className="text-[11px] text-deck-muted">连接远端主机后可管理飞书模型配置。</p>;
  if (!source.supportsFeishuPreferences || !source.expectedAuthority) {
    return <p className="text-[11px] text-deck-muted">当前远端版本不支持飞书模型配置，请升级后重试。</p>;
  }
  return <ConnectedPreferences key={`${source.identity}:${source.profileId}:${JSON.stringify(source.expectedAuthority)}`}
    profileId={source.profileId} source={source} />;
}
