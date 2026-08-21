export interface RemoteHookAvailability {
  profileId: string | null;
  supportsNodeHooksRead: boolean;
  usable: boolean;
}

export function remoteHookUnavailableReason(
  remote: RemoteHookAvailability,
): string | null {
  if (!remote.usable) return '当前远端环境尚未连接，暂时无法读取 Hook 状态。';
  if (!remote.supportsNodeHooksRead) {
    return '当前远端版本不支持读取 Hook 状态，请升级后重试。';
  }
  if (!remote.profileId) return '当前远端连接信息不完整。';
  return null;
}
