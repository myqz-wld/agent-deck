import { useEffect, useRef, useState, type JSX } from 'react';
import type { FeishuModelPreference, SessionConsoleCapabilitiesResult } from '@contracts/index';
import { useDelayedAsyncFallback, useInitialAsyncPresentation } from '@renderer/hooks/useDelayedAsyncFallback';
import { FeishuPreferenceEditor } from './FeishuPreferenceEditor';
import { Section } from './controls';
import { fetchFeishuPreferences, feishuPreferencesCache, feishuPreferencesKey, readFeishuPreferences,
  trackFeishuSave, type FeishuPreferencesSnapshot, type FeishuPreferencesSource } from './feishu-preferences-data';
export type { FeishuPreferencesSource } from './feishu-preferences-data';

export interface ManagedFeishuPreferences {
  snapshot: FeishuPreferencesSnapshot | null;
  pending: boolean;
  error: string | null;
}
interface Edit { preference: FeishuModelPreference; capability: SessionConsoleCapabilitiesResult }

function ConnectedPreferences({ source, managed }: {
  source: FeishuPreferencesSource;
  managed?: ManagedFeishuPreferences;
}): JSX.Element {
  const key = feishuPreferencesKey(source);
  const cached = feishuPreferencesCache.get(key);
  const initial = cached && cached.settings.settingsRevision > (managed?.snapshot?.settings.settingsRevision ?? -1)
    ? cached : managed?.snapshot ?? cached;
  const [snapshot, setSnapshot] = useState(initial);
  const [readError, setReadError] = useState<string | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [reading, setReading] = useState(!managed);
  const [saving, setSaving] = useState(false);
  const [retry, setRetry] = useState(0);
  const alive = useRef(true);
  const confirmed = useRef(initial);
  const queued = useRef<Edit | null>(null);
  const desired = useRef<Edit | null>(null);
  const processing = useRef(false);
  const reconcile = useRef(false);
  const sourceRef = useRef(source);
  sourceRef.current = source;
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  useEffect(() => {
    if (managed && retry === 0) {
      if (managed.snapshot && !processing.current && !desired.current &&
        managed.snapshot.settings.settingsRevision >= (confirmed.current?.settings.settingsRevision ?? -1)) {
        confirmed.current = managed.snapshot;
        setSnapshot(managed.snapshot);
      }
      return;
    }
    let cancelled = false;
    setReading(true);
    setReadError(null);
    void readFeishuPreferences(sourceRef.current).then(value => {
      if (cancelled) return;
      confirmed.current = value;
      setSnapshot(value);
    }).catch(() => { if (!cancelled) setReadError('读取机器人配置失败。'); })
      .finally(() => { if (!cancelled) setReading(false); });
    return () => { cancelled = true; };
  }, [key, retry, managed?.snapshot]);

  const managedError = retry === 0 ? managed?.error : null;
  const pending = reading || (retry === 0 && Boolean(managed?.pending));
  const error = readError ?? managedError ?? saveError;
  const presentation = useInitialAsyncPresentation(pending && !snapshot, key);
  const showReading = useDelayedAsyncFallback(pending, `${key}:read`);
  const showSaving = useDelayedAsyncFallback(saving, `${key}:save`);
  const save = (edit: Edit): void => {
    if (!confirmed.current || pending || readError || managedError || !source.profileId || !source.expectedAuthority) return;
    desired.current = edit;
    queued.current = edit;
    setSaveError(null);
    setSnapshot(current => current ? { settings: { ...current.settings, conversation: edit.preference }, capability: edit.capability } : current);
    if (processing.current) return;
    processing.current = true;
    setSaving(true);
    feishuPreferencesCache.delete(key);
    const target = source;
    const task = (async () => {
      if (reconcile.current) {
        confirmed.current = await fetchFeishuPreferences(target);
        reconcile.current = false;
      }
      while (queued.current) {
        const current = queued.current;
        queued.current = null;
        const settings = await window.api.updateRemoteHostFeishuPreferences({
          profileId: target.profileId!, purpose: 'conversation', preference: current.preference,
          expectedSettingsRevision: confirmed.current!.settings.settingsRevision,
          expectedAuthority: target.expectedAuthority!, intentId: crypto.randomUUID(),
        });
        const accepted = { settings, capability: current.capability };
        confirmed.current = accepted;
        feishuPreferencesCache.set(key, accepted);
        if (alive.current) {
          const latest = desired.current;
          setSnapshot(latest ? { settings: { ...settings, conversation: latest.preference }, capability: latest.capability } : accepted);
        }
      }
      desired.current = null;
    })().catch(() => {
      queued.current = null;
      reconcile.current = true;
      feishuPreferencesCache.delete(key);
      if (alive.current) setSaveError('配置未能确认保存，请重试。');
    }).finally(() => {
      processing.current = false;
      if (alive.current) setSaving(false);
    });
    trackFeishuSave(key, task);
  };

  if (!snapshot && presentation === 'deferred') return <div className="min-h-6" aria-hidden="true" />;
  return <div className="space-y-1.5">
    {snapshot ? <FeishuPreferenceEditor profileId={source.profileId!} value={snapshot.settings.conversation}
      initialCapability={snapshot.capability} blocked={pending || Boolean(readError || managedError)}
      busy={showReading || Boolean(readError || managedError)}
      status={showSaving ? '保存中…' : showReading ? '正在更新…' : null}
      onChange={(preference, capability) => save({ preference, capability })} />
      : !error && showReading ? <p role="status" className="text-[11px] text-deck-muted">正在读取机器人配置…</p> : null}
    {error && <p role="alert" className="text-[11px] text-status-waiting">
      {error} <button type="button" className="underline" disabled={saving || pending}
        onClick={() => { if (saveError && desired.current) save(desired.current); else setRetry(value => value + 1); }}>重试</button>
    </p>}
  </div>;
}

export function FeishuPreferencesSection({ source, managed }: {
  source: FeishuPreferencesSource | null;
  managed?: ManagedFeishuPreferences;
}): JSX.Element | null {
  if (!source) return null;
  return <Section title="机器人聊天" storageKey="feishu-conversation" keepMounted>
    {!source.usable || !source.profileId
      ? <p className="text-[11px] text-deck-muted">连接远端主机后可管理飞书模型配置。</p>
      : !source.supportsFeishuPreferences || !source.expectedAuthority
        ? <p className="text-[11px] text-deck-muted">当前远端版本不支持飞书模型配置，请升级后重试。</p>
        : <ConnectedPreferences key={feishuPreferencesKey(source)} source={source} managed={managed} />}
  </Section>;
}
