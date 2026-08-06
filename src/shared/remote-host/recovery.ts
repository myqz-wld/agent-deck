type RemoteHostRecoveryState =
  | { recovery: 'worker-offline' | null }
  | {
      topology: 'relay' | 'server-core' | 'standalone';
      status: string;
      error: { code: string } | null;
    };

export function isRecoverableRelayWorkerOffline(
  state: RemoteHostRecoveryState | null | undefined,
): boolean {
  if (state && 'recovery' in state) return state.recovery === 'worker-offline';
  return (
    state?.topology === 'relay' &&
    state.status === 'offline' &&
    state.error?.code === 'worker_offline'
  );
}
