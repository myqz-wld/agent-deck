import { remoteMutationAuthority } from './remote-source-utils';
import type { RemoteSessionSourceView } from './source-types';

function base(source: RemoteSessionSourceView) {
  return {
    identity: source.identity,
    label: source.profile?.label ?? '远端主机',
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
    supportsFeishuPreferences: source.capabilities.has('feishu.configuration'),
    expectedAuthority: remoteMutationAuthority(source.state),
    supportsNodeConfiguration: source.capabilities.has('node.configuration'),
    supportsNodeHooksRead: source.capabilities.has('node.hooks.read'),
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
