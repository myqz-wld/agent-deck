import type { NodeAssetDto } from '@contracts/index';
import type { AssetMeta, BundledAssetsSnapshot } from '@shared/types';

function toAssetMeta(asset: NodeAssetDto): AssetMeta {
  const runtime = asset.runtimeDefaults && asset.runtimeOverride
    ? {
        defaults: Object.fromEntries(Object.entries(asset.runtimeDefaults)
          .filter((entry): entry is [string, string] => entry[1] !== null)),
        override: Object.fromEntries(Object.entries(asset.runtimeOverride)
          .filter((entry): entry is [string, string] => entry[1] !== null)),
      }
    : null;
  return {
    kind: asset.kind,
    source: asset.source,
    adapter: asset.adapterId,
    name: asset.name,
    qualifiedName: asset.qualifiedName,
    description: asset.description,
    absPath: asset.location,
    ...(asset.tools === null ? {} : { tools: asset.tools }),
    ...(asset.model === null ? {} : { model: asset.model }),
    ...(asset.thinking === null ? {} : { thinking: asset.thinking }),
    ...(asset.provider === null ? {} : { provider: asset.provider }),
    ...(asset.origin === null ? {} : { origin: asset.origin }),
    ...(asset.pluginName === null ? {} : { pluginName: asset.pluginName }),
    ...(asset.runtimeName === null ? {} : { runtimeName: asset.runtimeName }),
    ...(runtime === null ? {} : { bundledAgentRuntime: runtime }),
  };
}

export function remoteAssetsSnapshot(assets: NodeAssetDto[]): BundledAssetsSnapshot {
  const mapped = assets.map(toAssetMeta);
  return {
    agents: mapped.filter((asset) => asset.kind === 'agent'),
    skills: mapped.filter((asset) => asset.kind === 'skill'),
  };
}
