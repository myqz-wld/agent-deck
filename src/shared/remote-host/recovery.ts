import type { RemoteHostStateDto } from './types';

type RemoteHostRecoveryState = Pick<
  RemoteHostStateDto,
  'error' | 'status' | 'topology'
>;

export function isRecoverableRelayWorkerOffline(
  state: RemoteHostRecoveryState | null | undefined,
): boolean {
  return (
    state?.topology === 'relay' &&
    state.status === 'offline' &&
    state.error?.code === 'worker_offline'
  );
}
