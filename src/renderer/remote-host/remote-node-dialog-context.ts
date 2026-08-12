import type { RemoteSessionSourceView } from './source-types';
import { remoteMutationAuthority } from './remote-source-utils';

function base(source: RemoteSessionSourceView) {
  return {
    identity: source.identity,
    expectedAuthority: remoteMutationAuthority(source.state),
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
    supportsNodeHooksRead: source.capabilities.has('node.hooks.read'),
    supportsNodeHooksWrite: source.capabilities.has('node.hooks.write'),
  } : null;
}

export function remoteAssetsDialogContext(
  remoteMode: boolean,
  source: RemoteSessionSourceView,
) {
  return remoteMode ? {
    ...base(source),
    supportsNodeAssets: source.capabilities.has('node.assets.bound'),
  } : null;
}
