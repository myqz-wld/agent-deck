import type {
  NodeHookProjectionResult,
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
  string
> = {
  'adapter-unavailable': '该 Provider 在当前 Worker 上不可用。',
  'status-unavailable': '该 Provider 未提供可安全读取的 Hook 状态。',
  'mutation-unavailable': '该 Provider 的 Hook 只能查看，当前 Worker 不允许修改。',
};

export function presentRemoteHookStatus(
  status: NodeHookProjectionStatusDto,
  supportsWrite: boolean,
): HookStatusPresentation {
  const writeAllowed = status.writeAllowed && supportsWrite;
  return {
    state: status.state,
    locationLabel: null,
    writeAllowed,
    disabledReason: status.disabledReason
      ? REMOTE_HOOK_DISABLED_COPY[status.disabledReason]
      : writeAllowed
        ? null
        : '当前 Remote Core 未提供 Hook 修改能力。',
  };
}

export function presentRemoteHookResult(
  result: NodeHookProjectionResult,
  expectedAdapterId: NodeHookProjectionResult['adapterId'],
  supportsWrite: boolean,
): HookStatusPresentation {
  if (result.adapterId !== expectedAdapterId) throw new Error('Remote Hook adapter mismatch');
  return presentRemoteHookStatus(result.status, supportsWrite);
}
