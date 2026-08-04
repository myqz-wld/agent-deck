import type { AgentDeckClient, AgentDeckSubscription, CoreMethodMap } from '@contracts/index';

import type { SshAgentDeckClient, SshConnectionState } from '@clients/ssh';

export interface ElectronHostClientBinding {
  client: AgentDeckClient<CoreMethodMap>;
  observeTransport?: (
    listener: (state: SshConnectionState) => void,
  ) => AgentDeckSubscription;
}

export function bindSshHostClient(client: SshAgentDeckClient): ElectronHostClientBinding {
  return {
    client,
    observeTransport: (listener) => client.onConnectionState(listener),
  };
}
