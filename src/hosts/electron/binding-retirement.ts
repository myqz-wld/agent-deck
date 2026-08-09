import type { AgentDeckSubscription } from '@contracts/index';

import type { ElectronHostClientBinding } from './client-binding';

export function retireElectronBinding(
  binding: ElectronHostClientBinding,
  subscriptions: readonly (AgentDeckSubscription | null)[],
): Promise<void> {
  return Promise.resolve().then(async () => {
    const errors: unknown[] = [];
    for (const subscription of subscriptions) {
      try {
        subscription?.close();
      } catch (error) {
        errors.push(error);
      }
    }
    try {
      await binding.client.close();
    } catch (error) {
      errors.push(error);
    }
    if (errors.length === 1) throw errors[0];
    if (errors.length > 1) {
      throw new AggregateError(errors, 'Host binding cleanup failed');
    }
  });
}
