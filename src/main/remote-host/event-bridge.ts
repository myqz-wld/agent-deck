import { eventBus } from '@main/event-bus';
import type { RemoteHostDataChangedDto } from '@shared/remote-host';

declare module '@main/event-bus' {
  interface EventMap {
    'remote-host-changed': [RemoteHostDataChangedDto];
  }
}

export function publishRemoteHostChanged(event: RemoteHostDataChangedDto): void {
  eventBus.emit('remote-host-changed', structuredClone(event));
}
