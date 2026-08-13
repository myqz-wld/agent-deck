import type {
  AssetMeta,
  BundledAgentRuntimeOverride,
  BundledAgentRuntimeOverrideMap,
} from '@shared/types';

function present(asset: AssetMeta): BundledAgentRuntimeOverride {
  return {
    ...(asset.model ? { model: asset.model } : {}),
    ...(asset.thinking ? { thinking: asset.thinking } : {}),
    ...(asset.provider ? { provider: asset.provider } : {}),
  };
}

/** Applies app-owned deltas only to immutable packaged Agents. */
export function applyServerCoreBundledAgentRuntimeOverride(
  asset: AssetMeta,
  overrides: BundledAgentRuntimeOverrideMap,
): AssetMeta {
  if (asset.source !== 'bundled' || asset.kind !== 'agent') return asset;
  const defaults = present(asset);
  const override = overrides[`${asset.adapter}:${asset.name}`] ?? {};
  return {
    ...asset,
    model: override.model ?? defaults.model,
    thinking: override.thinking ?? defaults.thinking,
    provider: override.provider ?? defaults.provider,
    bundledAgentRuntime: { defaults, override },
  };
}
