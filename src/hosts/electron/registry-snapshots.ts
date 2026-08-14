import type { ElectronHostProfile, ElectronHostState } from './model';

export function copyHostState(state: ElectronHostState): ElectronHostState {
  return {
    ...state,
    capabilities: [...state.capabilities],
    error: state.error && { ...state.error },
  };
}

export function sameHostState(left: ElectronHostState, right: ElectronHostState): boolean {
  return (
    left.profileId === right.profileId &&
    left.clientId === right.clientId &&
    left.topology === right.topology &&
    left.status === right.status &&
    left.instanceId === right.instanceId &&
    left.authoritativeCoreId === right.authoritativeCoreId &&
    left.workerGeneration === right.workerGeneration &&
    left.eventRevision === right.eventRevision &&
    left.error?.code === right.error?.code &&
    left.error?.message === right.error?.message &&
    left.capabilities.length === right.capabilities.length &&
    left.capabilities.every((capability, index) => capability === right.capabilities[index])
  );
}

export function copyHostProfile(profile: ElectronHostProfile): ElectronHostProfile {
  return profile.topology === 'standalone'
    ? { ...profile }
    : { ...profile, ssh: { ...profile.ssh } };
}

export function freezeHostProfile(profile: ElectronHostProfile): ElectronHostProfile {
  const snapshot = copyHostProfile(profile);
  if (snapshot.topology !== 'standalone') Object.freeze(snapshot.ssh);
  return Object.freeze(snapshot);
}
