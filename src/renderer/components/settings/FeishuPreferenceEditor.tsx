import { useEffect, useLayoutEffect, useRef, useState, type JSX } from 'react';
import { defaultFeishuModelPreference, FEISHU_PREFERENCE_OPTION_KEYS, feishuRuntimeOptionKeys,
  type FeishuModelPreference, type SessionConsoleCapabilitiesResult } from '@contracts/index';
import type { SessionThinkingLevel } from '@shared/session-metadata';
import { useDelayedAsyncFallback } from '@renderer/hooks/useDelayedAsyncFallback';
import type { DeckSelectOption } from '../DeckSelect';
import { InertInteractionBoundary } from '../InertInteractionBoundary';
import { FeishuRuntimePreferenceFields } from './FeishuRuntimePreferenceFields';
import { ProviderModelThinkingFields, type GeneratorAdapter } from './ProviderModelThinkingFields';
import { feishuPreferenceOverrides, resolveFeishuPreference, type FeishuPreferenceOptionKey } from './feishu-preference-defaults';

const LABEL = '机器人聊天';
const identityFor = (profileId: string, value: FeishuModelPreference): string =>
  JSON.stringify([profileId, value.adapterId, value.provider]);
const thinkingKey = (value: FeishuModelPreference): string => JSON.stringify([value.adapterId, value.provider]);

interface Selection {
  draft: FeishuModelPreference;
  overrides: readonly FeishuPreferenceOptionKey[];
}

export function FeishuPreferenceEditor({ profileId, value, initialCapability, blocked, busy, onSave }: {
  profileId: string;
  value: FeishuModelPreference;
  initialCapability: SessionConsoleCapabilitiesResult;
  blocked: boolean;
  busy: boolean;
  onSave(value: FeishuModelPreference): Promise<void>;
}): JSX.Element {
  const [selection, setSelection] = useState<Selection>(() => ({
    draft: resolveFeishuPreference(value, initialCapability), overrides: feishuPreferenceOverrides(value),
  }));
  const { draft } = selection;
  const [baseline, setBaseline] = useState(draft);
  const identity = identityFor(profileId, draft);
  const [capability, setCapability] = useState({ identity, value: initialCapability });
  const [failedIdentity, setFailedIdentity] = useState<string | null>(null);
  const serialized = JSON.stringify(value);
  const savedVersion = useRef(serialized);
  const gatewayThinking = useRef(new Map<string, string>(value.thinking ? [[thinkingKey(draft), value.thinking]] : []));
  useEffect(() => {
    if (savedVersion.current === serialized) return;
    savedVersion.current = serialized;
    const next = resolveFeishuPreference(value, capability.value);
    setSelection({ draft: next, overrides: feishuPreferenceOverrides(value) });
    setBaseline(next);
  }, [serialized, value, capability.value]);
  useEffect(() => {
    if (capability.identity === identity) return;
    let cancelled = false;
    setFailedIdentity(null);
    void window.api.getRemoteHostSessionCapabilities({ profileId, adapterId: draft.adapterId,
      provider: draft.provider, workingDirectory: '.' }).then((result) => {
      if (cancelled) return;
      const resolved = resolveFeishuPreference(draft, result, selection.overrides);
      setSelection({ draft: resolved, overrides: selection.overrides });
      setCapability({ identity: identityFor(profileId, resolved), value: result });
    }).catch(() => { if (!cancelled) setFailedIdentity(identity); });
    return () => { cancelled = true; };
  }, [identity, profileId, draft, selection.overrides, capability.identity]);

  const ready = capability.identity === identity;
  const failed = failedIdentity === identity;
  const showUpdating = useDelayedAsyncFallback(!ready && !failed, identity);
  const stable = useRef({ draft, capability: initialCapability });
  useLayoutEffect(() => {
    if (ready) stable.current = { draft, capability: capability.value };
  }, [draft, capability, ready]);
  const visible = ready ? { draft, capability: capability.value } : stable.current;
  const options = visible.capability.create.options;
  const unavailable = ready && (!capability.value.create.enabled || capability.value.selectedAdapterId !== draft.adapterId);
  const changed = value.adapterId === null || JSON.stringify(draft) !== JSON.stringify(baseline);
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
  const adapterOptions: DeckSelectOption<GeneratorAdapter>[] = visible.capability.adapters.map((adapter) => ({
    value: adapter.adapterId as GeneratorAdapter,
    label: `${adapter.displayName}${adapter.enabled ? '' : '（暂不可用）'}`, disabled: !adapter.enabled,
  }));
  if (visible.draft.adapterId && !adapterOptions.some((item) => item.value === visible.draft.adapterId)) {
    adapterOptions.push({ value: visible.draft.adapterId, label: `${visible.draft.adapterId}（暂不可用）`, disabled: true });
  }
  const thinkingOptions: DeckSelectOption<SessionThinkingLevel>[] = (options.thinking.allowedValues ?? [])
    .map(item => ({ value: item as SessionThinkingLevel, label: item.toUpperCase() }));
  if (visible.draft.thinking && !thinkingOptions.some(item => item.value === visible.draft.thinking)) {
    thinkingOptions.push({ value: visible.draft.thinking as SessionThinkingLevel,
      label: `${visible.draft.thinking}（暂不可用）`, disabled: true });
  }
  const change = (field: FeishuPreferenceOptionKey, value: string | null): void => {
    if (interactionBlocked) return;
    if (field === 'thinking' && value) gatewayThinking.current.set(thinkingKey(draft), value);
    setSelection(current => ({ draft: { ...current.draft, [field]: value },
      overrides: [...new Set([...current.overrides, field])] }));
  };
  const changeProvider = (provider: string): void => {
    if (interactionBlocked || provider === draft.provider) return;
    const thinking = gatewayThinking.current.get(thinkingKey({ ...draft, provider }));
    setSelection({ draft: { ...draft, provider, ...(thinking ? { thinking } : {}) },
      overrides: [...selection.overrides.filter(key => !['provider', 'model', 'thinking'].includes(key)),
        'provider', ...(thinking ? ['thinking' as const] : [])] });
  };

  return <InertInteractionBoundary blocked={interactionBlocked}>
    <fieldset className="space-y-2" disabled={disabled}>
      <ProviderModelThinkingFields label={LABEL}
        hint="未设置的选项使用远端新建会话的默认值，可修改后保存。"
        adapter={visible.draft.adapterId as GeneratorAdapter} adapterOptions={adapterOptions}
        runtimeProvider={visible.draft.provider}
        providerOptions={(options.provider.allowedValues ?? []).map(id => ({ id }))}
        model={visible.draft.model} modelPlaceholder="留空使用所选助手或网关的默认模型"
        thinking={visible.draft.thinking as SessionThinkingLevel} thinkingOptions={thinkingOptions}
        disabled={disabled}
        onAdapterChange={adapterId => {
          if (!interactionBlocked && adapterId !== draft.adapterId) {
            setSelection({ draft: { ...defaultFeishuModelPreference(), adapterId }, overrides: [] });
          }
        }}
        onRuntimeProviderChange={changeProvider}
        onModelChange={value => change('model', value)}
        onThinkingChange={value => change('thinking', value)} />
      <div className="grid grid-cols-2 gap-2">
        {feishuRuntimeOptionKeys(visible.draft.adapterId).map(field => <FeishuRuntimePreferenceFields key={field}
          field={field} purposeLabel={LABEL} value={visible.draft[field] ?? null}
          descriptor={options[field]} sandbox={visible.capability.create.sandbox}
          disabled={disabled} onChange={value => change(field, value)} />)}
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
