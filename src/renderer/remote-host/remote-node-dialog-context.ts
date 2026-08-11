import type { RemoteSessionSourceView } from './source-types';

function base(source: RemoteSessionSourceView) {
  return {
    identity: source.identity,
    label: source.profile?.label ?? 'Remote Worker',
    profileId: source.profile?.id ?? null,
    usable: source.usable,
  };
}

export function remoteConfigurationDialogContext(
  remoteMode: boolean,
  source: RemoteSessionSourceView,
) {
  return remoteMode ? {
    ...base(source),
    supportsNodeConfiguration: source.capabilities.has('node.configuration'),
  } : null;
}

export function remoteAssetsDialogContext(
  remoteMode: boolean,
  source: RemoteSessionSourceView,
) {
  return remoteMode ? {
    ...base(source),
    supportsNodeAssets: source.capabilities.has('node.assets'),
  } : null;
}
