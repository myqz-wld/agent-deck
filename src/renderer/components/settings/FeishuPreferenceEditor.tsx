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

export function FeishuPreferenceEditor({ profileId, value, initialCapability, blocked, busy, status, onChange }: {
  profileId: string;
  value: FeishuModelPreference;
  initialCapability: SessionConsoleCapabilitiesResult;
  blocked: boolean;
  busy: boolean;
  status?: string | null;
  onChange(value: FeishuModelPreference, capability: SessionConsoleCapabilitiesResult): void;
}): JSX.Element {
  const [selection, setSelection] = useState<Selection>(() => ({
    draft: resolveFeishuPreference(value, initialCapability), overrides: feishuPreferenceOverrides(value),
  }));
  const { draft } = selection;
  const [editVersion, setEditVersion] = useState(0);
  const sentVersion = useRef(0);
  const identity = identityFor(profileId, draft);
  const [capability, setCapability] = useState({ identity, value: initialCapability });
  const [failedIdentity, setFailedIdentity] = useState<string | null>(null);
  const serialized = JSON.stringify(value);
  const savedVersion = useRef({ serialized, capability: initialCapability });
  const gatewayThinking = useRef(new Map<string, string>(value.thinking ? [[thinkingKey(draft), value.thinking]] : []));
  useEffect(() => {
    if (savedVersion.current.serialized === serialized && savedVersion.current.capability === initialCapability) return;
    savedVersion.current = { serialized, capability: initialCapability };
    const next = resolveFeishuPreference(value, initialCapability);
    setSelection({ draft: next, overrides: feishuPreferenceOverrides(value) });
    setCapability({ identity: identityFor(profileId, next), value: initialCapability });
  }, [serialized, value, initialCapability, profileId]);
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
  const valid = ready && !failed && draft.adapterId !== null && !unavailable &&
    FEISHU_PREFERENCE_OPTION_KEYS.every((key) => !draft[key] ||
      (options[key].enabled && (options[key].allowCustom || options[key].allowedValues?.includes(draft[key]))));
  const interactionBlocked = blocked || !ready || failed;
  const disabled = busy || showUpdating || failed;
  useEffect(() => {
    if (interactionBlocked || !valid || editVersion === sentVersion.current) return;
    sentVersion.current = editVersion;
    onChange(draft, capability.value);
  }, [editVersion, interactionBlocked, valid, draft, capability.value, onChange]);
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
    setEditVersion(current => current + 1);
    if (field === 'thinking' && value) gatewayThinking.current.set(thinkingKey(draft), value);
    setSelection(current => ({ draft: { ...current.draft, [field]: value },
      overrides: [...new Set([...current.overrides, field])] }));
  };
  const changeProvider = (provider: string): void => {
    if (interactionBlocked || provider === draft.provider) return;
    setEditVersion(current => current + 1);
    const thinking = gatewayThinking.current.get(thinkingKey({ ...draft, provider }));
    setSelection({ draft: { ...draft, provider, ...(thinking ? { thinking } : {}) },
      overrides: [...selection.overrides.filter(key => !['provider', 'model', 'thinking'].includes(key)),
        'provider', ...(thinking ? ['thinking' as const] : [])] });
  };

  return <InertInteractionBoundary blocked={interactionBlocked}>
    <fieldset disabled={disabled}>
      <ProviderModelThinkingFields label={LABEL}
        hint=""
        status={(showUpdating || status) && <span role="status" className="text-[10px] font-normal text-deck-muted">{showUpdating ? '正在更新…' : status}</span>}
        adapter={visible.draft.adapterId as GeneratorAdapter} adapterOptions={adapterOptions}
        runtimeProvider={visible.draft.provider}
        providerOptions={(options.provider.allowedValues ?? []).map(id => ({ id }))}
        model={visible.draft.model} modelPlaceholder="留空使用所选助手或网关的默认模型"
        thinking={visible.draft.thinking as SessionThinkingLevel} thinkingOptions={thinkingOptions}
        disabled={disabled}
        onAdapterChange={adapterId => {
          if (!interactionBlocked) {
            setEditVersion(current => current + 1);
            if (adapterId !== draft.adapterId) setSelection({ draft: { ...defaultFeishuModelPreference(), adapterId }, overrides: [] });
          }
        }}
        onRuntimeProviderChange={changeProvider}
        onModelChange={value => change('model', value)}
        onThinkingChange={value => change('thinking', value)}>
        {feishuRuntimeOptionKeys(visible.draft.adapterId).map(field => <FeishuRuntimePreferenceFields key={field}
          field={field} purposeLabel={LABEL} value={visible.draft[field] ?? null}
          descriptor={options[field]} sandbox={visible.capability.create.sandbox}
          disabled={disabled} onChange={value => change(field, value)} />)}
      </ProviderModelThinkingFields>
      {(failed || unavailable) && <div className="mt-1.5 text-[10px]">
        {failed ? <p role="alert" className="text-status-waiting">无法读取可用配置，请重新打开设置后重试。</p>
          : unavailable ? <p role="alert" className="text-status-waiting">原选择暂不可用，请重新选择。</p>
            : null}
      </div>}
    </fieldset>
  </InertInteractionBoundary>;
}
