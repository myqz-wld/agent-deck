import type {
  NodeHookProjectionStatusDto,
} from '@contracts/index';
import type { HookInstallStatus } from '@shared/types';

import type { HookStatusPresentation } from './sections/HookSection';

export function presentLocalHookStatus(status: HookInstallStatus): HookStatusPresentation {
  return {
    state: status.installed
      ? 'installed'
      : status.installedHooks.length > 0
        ? 'partial'
        : 'not-installed',
    locationLabel: status.settingsPath,
    writeAllowed: true,
    disabledReason: null,
  };
}

const REMOTE_HOOK_DISABLED_COPY: Record<
  Exclude<NodeHookProjectionStatusDto['disabledReason'], null>,
  string | null
> = {
  'adapter-unavailable': '当前远端环境未启用此工具。',
  'status-unavailable': '暂时无法读取 Hook 状态。',
  'mutation-unavailable': null,
};

export function presentRemoteHookStatus(
  status: NodeHookProjectionStatusDto,
): HookStatusPresentation {
  return {
    state: status.state,
    locationLabel: null,
    writeAllowed: false,
    disabledReason: status.disabledReason
      ? REMOTE_HOOK_DISABLED_COPY[status.disabledReason]
      : null,
  };
}
