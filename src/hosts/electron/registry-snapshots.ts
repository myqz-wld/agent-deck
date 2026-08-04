import type { ElectronHostProfile, ElectronHostState } from './model';

export function copyHostState(state: ElectronHostState): ElectronHostState {
  return {
    ...state,
    capabilities: [...state.capabilities],
    error: state.error && { ...state.error },
  };
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
