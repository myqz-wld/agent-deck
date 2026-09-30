import { useEffect, useRef, useState, type JSX } from 'react';
import { defaultFeishuModelPreference, FEISHU_PREFERENCE_OPTION_KEYS, feishuRuntimeOptionKeys,
  type FeishuModelPreference, type FeishuPreferencesResult,
  type FeishuPreferencePurpose, type SessionConsoleCapabilitiesResult } from '@contracts/index';
import type { RemoteHostMutationAuthorityDto } from '@shared/remote-host';
import { DeckSelect } from '../DeckSelect';
import { useInitialAsyncPresentation } from '@renderer/hooks/useDelayedAsyncFallback';
import { FeishuRuntimePreferenceFields } from './FeishuRuntimePreferenceFields';

export interface FeishuPreferencesSource {
  identity: string;
  profileId: string | null;
  usable: boolean;
  supportsFeishuPreferences?: boolean;
  expectedAuthority?: RemoteHostMutationAuthorityDto;
}

const INPUT = 'w-full min-w-0 rounded border border-deck-border bg-white/[0.04] px-2 py-1 text-[11px] text-deck-text disabled:opacity-50';
const LABELS = { conversation: '机器人聊天', session: '新建会话' } as const;

function PreferenceEditor({ profileId, purpose, value, busy, onSave }: {
  profileId: string; purpose: FeishuPreferencePurpose; value: FeishuModelPreference; busy: boolean;
  onSave: (purpose: FeishuPreferencePurpose, value: FeishuModelPreference) => Promise<void>;
}): JSX.Element {
  const [draft, setDraft] = useState(value);
  const [capability, setCapability] = useState<{ identity: string; value: SessionConsoleCapabilitiesResult } | null>(null);
  const [failed, setFailed] = useState(false);
  const identity = JSON.stringify([profileId, draft.adapterId, draft.provider]);
  const serialized = JSON.stringify(value);
  useEffect(() => { setDraft(JSON.parse(serialized) as FeishuModelPreference); }, [serialized]);
  useEffect(() => {
    let cancelled = false;
    setFailed(false);
    void window.api.getRemoteHostSessionCapabilities({ profileId, adapterId: draft.adapterId,
      provider: draft.provider, workingDirectory: '.' }).then((result) => {
      if (!cancelled) setCapability({ identity, value: result });
    }).catch(() => { if (!cancelled) { setCapability(null); setFailed(true); } });
    return () => { cancelled = true; };
  }, [identity, profileId, draft.adapterId, draft.provider]);
  const ready = capability?.identity === identity;
  const options = capability?.value.create.options ?? null;
  const unavailable = ready && draft.adapterId !== null &&
    (!capability.value.create.enabled || capability.value.selectedAdapterId !== draft.adapterId);
  const presentation = useInitialAsyncPresentation(!ready && !failed, identity);
  const changed = JSON.stringify(draft) !== serialized;
  const valid = draft.adapterId !== null && ready && !unavailable &&
    FEISHU_PREFERENCE_OPTION_KEYS.every((key) => !draft[key] ||
      (options?.[key].enabled && (options[key].allowCustom || options[key].allowedValues?.includes(draft[key]))));
  const adapterOptions = [{ value: '', label: '请选择助手' }, ...(capability?.value.adapters ?? []).map((adapter) => ({
    value: adapter.adapterId, label: `${adapter.displayName}${adapter.enabled ? '' : '（暂不可用）'}`, disabled: !adapter.enabled,
  }))];
  if (draft.adapterId && !adapterOptions.some((item) => item.value === draft.adapterId)) {
    adapterOptions.push({ value: draft.adapterId, label: `${draft.adapterId}（原选择）` });
  }
  if (!capability) return <fieldset className="rounded border border-deck-border p-2">
    <legend className="px-1 text-[11px] text-deck-text">{LABELS[purpose]}</legend>
    {failed ? <p role="alert" className="text-[10px] text-status-waiting">无法读取可用模型，请刷新后重试。</p>
      : presentation === 'fallback' ? <p role="status" className="text-[10px] text-deck-muted">正在读取可用模型…</p>
        : <div className="min-h-6" />}
  </fieldset>;
  return <fieldset className="space-y-2 rounded border border-deck-border p-2" disabled={busy}>
    <legend className="px-1 text-[11px] text-deck-text">{LABELS[purpose]}</legend>
    <div className="grid grid-cols-2 gap-2">
      <label className="text-[10px] text-deck-muted">助手
        <DeckSelect value={draft.adapterId ?? ''} options={adapterOptions} disabled={busy || !capability}
          ariaLabel={`${LABELS[purpose]} 助手`} onChange={(adapterId) => setDraft({ ...defaultFeishuModelPreference(),
            adapterId: (adapterId || null) as FeishuModelPreference['adapterId'] })} />
      </label>
      {(['provider', 'model', 'thinking'] as const).map((field) => {
        const label = { provider: '模型网关', model: '模型', thinking: '思考程度' }[field];
        const descriptor = options?.[field];
        const choices = [{ value: '', label: '跟随原生设置' }, ...(descriptor?.allowedValues ?? [])
          .filter(Boolean).map((item) => ({ value: item, label: item }))];
        if (draft[field] && !choices.some((item) => item.value === draft[field])) {
          choices.push({ value: draft[field], label: `${draft[field]}（原选择）` });
        }
        const disabled = busy || !ready || !draft.adapterId || !descriptor?.enabled;
        return <label key={field} className="text-[10px] text-deck-muted">{label}
          {descriptor?.allowCustom ? <>
            <input aria-label={`${LABELS[purpose]} ${label}`} className={INPUT} value={draft[field]}
              disabled={disabled} placeholder="跟随原生设置" list={`feishu-${purpose}-${field}`}
              onChange={(event) => setDraft({ ...draft, [field]: event.target.value })} />
            <datalist id={`feishu-${purpose}-${field}`}>{descriptor.allowedValues?.map((item) => <option key={item} value={item} />)}</datalist>
          </> : <DeckSelect value={draft[field]} options={choices} disabled={disabled}
            ariaLabel={`${LABELS[purpose]} ${label}`} onChange={(item) => setDraft({ ...draft, [field]: item })} />}
        </label>;
      })}
      {feishuRuntimeOptionKeys(draft.adapterId).map(field => <FeishuRuntimePreferenceFields key={field}
        field={field} purposeLabel={LABELS[purpose]} value={draft[field] ?? null}
        descriptor={options?.[field]} sandbox={capability.value.create.sandbox}
        disabled={busy || !ready || !draft.adapterId}
        onChange={value => setDraft({ ...draft, [field]: value })} />)}
    </div>
    <p className="text-[10px] text-deck-muted">模式与沙盒按所选助手分别保存；远端仍受 Core Workspace 边界约束。</p>
    {failed && <p role="alert" className="text-[10px] text-status-waiting">无法读取可用模型，请刷新后重试。</p>}
    {unavailable && <p role="alert" className="text-[10px] text-status-waiting">原选择暂不可用，请重新选择；不会自动切换助手。</p>}
    {presentation === 'fallback' && <p role="status" className="text-[10px] text-deck-muted">正在读取可用模型…</p>}
    <button type="button" className="rounded bg-white/10 px-2 py-1 text-[11px] disabled:opacity-40"
      disabled={busy || !changed || !valid} onClick={() => { void onSave(purpose, draft); }}>保存{LABELS[purpose]}选择</button>
  </fieldset>;
}

function ConnectedPreferences({ profileId, source }: { profileId: string; source: FeishuPreferencesSource }): JSX.Element {
  const [settings, setSettings] = useState<FeishuPreferencesResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [refresh, setRefresh] = useState(0);
  const alive = useRef(true);
  const saving = useRef(false);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  useEffect(() => {
    let cancelled = false;
    setError(null);
    setSettings(null);
    void window.api.getRemoteHostFeishuPreferences({ profileId }).then((result) => {
      if (!cancelled) setSettings(result);
    }).catch(() => { if (!cancelled) setError('读取模型配置失败，请刷新后重试。'); });
    return () => { cancelled = true; };
  }, [profileId, refresh]);
  const presentation = useInitialAsyncPresentation(!settings && !error, `${source.identity}:${refresh}`);
  const save = async (purpose: FeishuPreferencePurpose, preference: FeishuModelPreference): Promise<void> => {
    if (!settings || saving.current || error || !source.expectedAuthority) return;
    saving.current = true;
    setBusy(true);
    try {
      const result = await window.api.updateRemoteHostFeishuPreferences({ profileId, purpose, preference,
        expectedSettingsRevision: settings.settingsRevision, expectedAuthority: source.expectedAuthority,
        intentId: crypto.randomUUID() });
      if (alive.current) setSettings(result);
    } catch {
      if (alive.current) setError('保存未确认，或配置已在飞书中修改。请刷新核对后再保存。');
    } finally { saving.current = false; if (alive.current) setBusy(false); }
  };
  return <div className="space-y-2">
    <p className="text-[10px] leading-relaxed text-deck-muted">与飞书同步，分别沿用上次选择。修改后用于新对话和新建会话，已开始的会话保持原配置。</p>
    {error && <p role="alert" className="text-[11px] text-status-waiting">{error}</p>}
    {settings ? (['conversation', 'session'] as const).map((purpose) => <PreferenceEditor
      key={`${refresh}:${purpose}`} profileId={profileId} purpose={purpose} value={settings[purpose]}
      busy={busy || Boolean(error)} onSave={save} />) : presentation === 'fallback'
      ? <p role="status" className="text-[11px] text-deck-muted">正在读取模型配置…</p> : <div className="min-h-6" />}
    <button type="button" disabled={busy} className="text-[11px] text-deck-muted hover:text-deck-text"
      onClick={() => setRefresh((value) => value + 1)}>刷新配置</button>
  </div>;
}

export function FeishuPreferencesSection({ source }: { source: FeishuPreferencesSource | null }): JSX.Element {
  if (!source) return <p className="text-[11px] text-deck-muted">切换到机器人连接的远端主机后，可在这里管理飞书模型配置。</p>;
  if (!source.usable || !source.profileId) return <p className="text-[11px] text-deck-muted">连接远端主机后可管理飞书模型配置。</p>;
  if (!source.supportsFeishuPreferences || !source.expectedAuthority) {
    return <p className="text-[11px] text-deck-muted">当前远端版本不支持飞书模型配置，请升级后重试。</p>;
  }
  return <ConnectedPreferences key={`${source.identity}:${JSON.stringify(source.expectedAuthority)}`}
    profileId={source.profileId} source={source} />;
}
