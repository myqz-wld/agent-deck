import { SshAgentDeckClient, type SshTransportOptions } from '@clients/ssh';

import { bindSshHostClient, type ElectronHostClientBinding } from './client-binding';
import type {
  ElectronHostProfile,
  StandaloneElectronHostProfile,
} from './model';

export interface ElectronHostClientFactoryOptions {
  readonly createStandalone: (
    profile: StandaloneElectronHostProfile,
  ) => ElectronHostClientBinding;
  readonly ssh?: SshTransportOptions;
}

/** Keeps concrete SSH process ownership in Electron main and outside renderer-facing state. */
export function createElectronHostClientFactory(
  options: ElectronHostClientFactoryOptions,
): (profile: ElectronHostProfile) => ElectronHostClientBinding {
  return (profile) => {
    if (profile.topology === 'standalone') return options.createStandalone(profile);
    return bindSshHostClient(new SshAgentDeckClient(profile.ssh, options.ssh));
  };
}
