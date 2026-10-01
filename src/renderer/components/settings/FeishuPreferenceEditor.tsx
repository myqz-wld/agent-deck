import { useEffect, useLayoutEffect, useRef, useState, type JSX } from 'react';
import { defaultFeishuModelPreference, FEISHU_PREFERENCE_OPTION_KEYS, feishuRuntimeOptionKeys,
  type FeishuModelPreference, type SessionConsoleCapabilitiesResult } from '@contracts/index';
import { useDelayedAsyncFallback } from '@renderer/hooks/useDelayedAsyncFallback';
import { DeckSelect } from '../DeckSelect';
import { InertInteractionBoundary } from '../InertInteractionBoundary';
import { FeishuRuntimePreferenceFields } from './FeishuRuntimePreferenceFields';

const INPUT = 'w-full min-w-0 rounded border border-deck-border bg-white/[0.04] px-2 py-1 text-[11px] text-deck-text disabled:opacity-50';
const LABEL = '机器人聊天';

export function FeishuPreferenceEditor({ profileId, value, initialCapability, blocked, busy, onSave }: {
  profileId: string;
  value: FeishuModelPreference;
  initialCapability: SessionConsoleCapabilitiesResult;
  blocked: boolean;
  busy: boolean;
  onSave(value: FeishuModelPreference): Promise<void>;
}): JSX.Element {
  const [draft, setDraft] = useState(value);
  const identity = JSON.stringify([profileId, draft.adapterId, draft.provider]);
  const [capability, setCapability] = useState({ identity, value: initialCapability });
  const [failedIdentity, setFailedIdentity] = useState<string | null>(null);
  const serialized = JSON.stringify(value);
  useEffect(() => { setDraft(JSON.parse(serialized) as FeishuModelPreference); }, [serialized]);
  useEffect(() => {
    if (capability.identity === identity) return;
    let cancelled = false;
    setFailedIdentity(null);
    void window.api.getRemoteHostSessionCapabilities({ profileId, adapterId: draft.adapterId,
      provider: draft.provider, workingDirectory: '.' }).then((result) => {
      if (!cancelled) setCapability({ identity, value: result });
    }).catch(() => { if (!cancelled) setFailedIdentity(identity); });
    return () => { cancelled = true; };
  }, [identity, profileId, draft.adapterId, draft.provider, capability.identity]);

  const ready = capability.identity === identity;
  const failed = failedIdentity === identity;
  const showUpdating = useDelayedAsyncFallback(!ready && !failed, identity);
  const stable = useRef({ draft, capability: initialCapability });
  useLayoutEffect(() => {
    if (ready) stable.current = { draft, capability: capability.value };
  }, [draft, capability, ready]);
  const visible = ready ? { draft, capability: capability.value } : stable.current;
  const options = visible.capability.create.options;
  const unavailable = ready && draft.adapterId !== null &&
    (!capability.value.create.enabled || capability.value.selectedAdapterId !== draft.adapterId);
  const changed = JSON.stringify(draft) !== serialized;
  const valid = ready && !failed && draft.adapterId !== null && !unavailable &&
    FEISHU_PREFERENCE_OPTION_KEYS.every((key) => !draft[key] ||
      (options[key].enabled && (options[key].allowCustom || options[key].allowedValues?.includes(draft[key]))));
  const interactionBlocked = blocked || !ready || failed;
  const disabled = busy || showUpdating || failed;
  const saveDisabled = disabled || !changed || !valid;
  const lastSaveDisabled = useRef(saveDisabled);
  useLayoutEffect(() => {
    if (ready && !blocked) lastSaveDisabled.current = saveDisabled;
  }, [ready, blocked, saveDisabled]);
  const visibleSaveDisabled = !ready && !showUpdating && !failed ? lastSaveDisabled.current : saveDisabled;
  const adapterOptions = [{ value: '', label: '请选择助手' }, ...visible.capability.adapters.map((adapter) => ({
    value: adapter.adapterId, label: `${adapter.displayName}${adapter.enabled ? '' : '（暂不可用）'}`, disabled: !adapter.enabled,
  }))];
  if (visible.draft.adapterId && !adapterOptions.some((item) => item.value === visible.draft.adapterId)) {
    adapterOptions.push({ value: visible.draft.adapterId, label: `${visible.draft.adapterId}（原选择）` });
  }

  return <InertInteractionBoundary blocked={interactionBlocked}>
    <fieldset className="space-y-2 rounded border border-deck-border p-2" disabled={disabled}>
      <legend className="px-1 text-[11px] text-deck-text">{LABEL}</legend>
      <div className="grid grid-cols-2 gap-2">
        <label className="text-[10px] text-deck-muted">助手
          <DeckSelect value={visible.draft.adapterId ?? ''} options={adapterOptions} disabled={disabled}
            ariaLabel={`${LABEL} 助手`} onChange={(adapterId) => {
              if (!interactionBlocked) setDraft({ ...defaultFeishuModelPreference(),
                adapterId: (adapterId || null) as FeishuModelPreference['adapterId'] });
            }} />
        </label>
        {(['provider', 'model', 'thinking'] as const).map((field) => {
          const descriptor = options[field];
          if (!descriptor.enabled) return null;
          const label = { provider: '模型网关', model: '模型', thinking: '思考程度' }[field];
          const selected = visible.draft[field] || descriptor.defaultValue || '';
          const choices = [
            ...(field === 'provider' ? [{ value: '', label: '原生网关', disabled: false }] : []),
            ...(descriptor.allowedValues ?? []).filter(Boolean).map((item) => ({ value: item, label: item, disabled: false })),
          ];
          if (selected && !choices.some((item) => item.value === selected)) {
            choices.push({ value: selected, label: `${selected}（暂不可用）`, disabled: true });
          }
          const fieldDisabled = disabled || !visible.draft.adapterId;
          const change = (item: string): void => {
            if (interactionBlocked) return;
            setDraft(field === 'provider' ? { ...draft, provider: item, model: '', thinking: '' }
              : { ...draft, [field]: item });
          };
          return <label key={field} className="text-[10px] text-deck-muted">{label}
            {field === 'model' ? <input aria-label={`${LABEL} ${label}`} className={INPUT}
              value={visible.draft.model} disabled={fieldDisabled}
              placeholder={descriptor.defaultValue || '使用助手配置中的模型'}
              onChange={(event) => change(event.target.value)} />
              : <DeckSelect value={selected} options={choices} disabled={fieldDisabled}
                ariaLabel={`${LABEL} ${label}`} onChange={change} />}
          </label>;
        })}
        {feishuRuntimeOptionKeys(visible.draft.adapterId).map(field => <FeishuRuntimePreferenceFields key={field}
          field={field} purposeLabel={LABEL} value={visible.draft[field] ?? null}
          descriptor={options[field]} sandbox={visible.capability.create.sandbox}
          disabled={disabled || !visible.draft.adapterId}
          onChange={value => { if (!interactionBlocked) setDraft({ ...draft, [field]: value }); }} />)}
      </div>
      <div className="min-h-4 text-[10px]">
        {failed ? <p role="alert" className="text-status-waiting">无法读取可用配置，请刷新后重试。</p>
          : unavailable ? <p role="alert" className="text-status-waiting">原选择暂不可用，请重新选择。</p>
            : showUpdating ? <p role="status" className="text-deck-muted">正在读取可用配置…</p> : null}
      </div>
      <button type="button" className="rounded bg-white/10 px-2 py-1 text-[11px] disabled:opacity-40"
        disabled={visibleSaveDisabled} onClick={() => {
          if (!interactionBlocked && valid && changed) void onSave(draft);
        }}>保存{LABEL}选择</button>
    </fieldset>
  </InertInteractionBoundary>;
}
