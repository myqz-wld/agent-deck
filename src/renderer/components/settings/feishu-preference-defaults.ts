import { FEISHU_PREFERENCE_OPTION_KEYS, feishuRuntimeOptionKeys,
  type FeishuModelPreference, type SessionConsoleCapabilitiesResult } from '@contracts/index';

export type FeishuPreferenceOptionKey = typeof FEISHU_PREFERENCE_OPTION_KEYS[number];

export function feishuPreferenceOverrides(value: FeishuModelPreference): FeishuPreferenceOptionKey[] {
  return FEISHU_PREFERENCE_OPTION_KEYS.filter(key => Boolean(value[key]));
}

/** Use the same live defaults as remote creation, then retain explicit saved or edited values. */
export function resolveFeishuPreference(
  value: FeishuModelPreference,
  capability: SessionConsoleCapabilitiesResult,
  overrides: readonly FeishuPreferenceOptionKey[] = feishuPreferenceOverrides(value),
): FeishuModelPreference {
  if (value.adapterId && value.adapterId !== capability.selectedAdapterId) return value;
  const adapterId = value.adapterId ?? capability.selectedAdapterId as FeishuModelPreference['adapterId'];
  const options = capability.create.options;
  const selected = new Set(overrides);
  const text = (key: 'provider' | 'model' | 'thinking'): string =>
    selected.has(key) ? value[key] : options[key].defaultValue ?? '';
  return {
    adapterId, provider: text('provider'), model: text('model'), thinking: text('thinking'),
    ...Object.fromEntries(feishuRuntimeOptionKeys(adapterId).map(key => [key,
      selected.has(key) ? value[key] : options[key].defaultValue])),
  };
}
