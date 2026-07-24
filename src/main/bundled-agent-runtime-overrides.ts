import type {
  AssetAdapter,
  BundledAgentRuntimeOverride,
  BundledAgentRuntimeOverrideMap,
} from '@shared/types';
import { settingsStore } from '@main/store/settings-store';
import {
  bundledAgentRuntimeKey,
  normalizeBundledAgentRuntimeOverride,
  normalizeBundledAgentRuntimeOverrideMap,
} from './bundled-agent-runtime-validation';

export function getBundledAgentRuntimeOverrides(): BundledAgentRuntimeOverrideMap {
  try {
    return normalizeBundledAgentRuntimeOverrideMap(
      settingsStore.get('bundledAgentRuntimeOverrides'),
    );
  } catch {
    return {};
  }
}

export function getBundledAgentRuntimeOverride(
  adapter: AssetAdapter,
  name: string,
): BundledAgentRuntimeOverride {
  return getBundledAgentRuntimeOverrides()[bundledAgentRuntimeKey(adapter, name)] ?? {};
}

export function saveBundledAgentRuntimeOverride(
  adapter: AssetAdapter,
  name: string,
  value: unknown,
): BundledAgentRuntimeOverride {
  const override = normalizeBundledAgentRuntimeOverride(adapter, value);
  const next = getBundledAgentRuntimeOverrides();
  const key = bundledAgentRuntimeKey(adapter, name);
  if (Object.keys(override).length === 0) delete next[key];
  else next[key] = override;
  settingsStore.set('bundledAgentRuntimeOverrides', next);
  return override;
}

export function resetBundledAgentRuntimeOverride(
  adapter: AssetAdapter,
  name: string,
): void {
  const next = getBundledAgentRuntimeOverrides();
  delete next[bundledAgentRuntimeKey(adapter, name)];
  settingsStore.set('bundledAgentRuntimeOverrides', next);
}
