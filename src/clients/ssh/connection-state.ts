import type { HostHello } from '@contracts/index';

import {
  cloneSshConnectionState,
  freezeSshConnectionState,
} from './snapshots';
import type {
  SshConnectionState,
  SshHostProfile,
  SshStateSubscription,
} from './types';

export class SshConnectionStatePublisher {
  private readonly listeners = new Set<(state: SshConnectionState) => void>();
  private stateValue: SshConnectionState;

  constructor(private readonly profile: Readonly<SshHostProfile>) {
    this.stateValue = freezeSshConnectionState({
      profileId: profile.id,
      topology: profile.topology,
      status: 'idle',
      attempt: 0,
      hello: null,
      reason: null,
      errorCode: null,
    });
  }

  get value(): SshConnectionState {
    return this.stateValue;
  }

  snapshot(): SshConnectionState {
    return cloneSshConnectionState(this.stateValue);
  }

  subscribe(listener: (state: SshConnectionState) => void): SshStateSubscription {
    this.listeners.add(listener);
    try {
      listener(this.snapshot());
    } catch {}
    return { close: () => this.listeners.delete(listener) };
  }

  publish(
    status: SshConnectionState['status'],
    attempt: number,
    hello: HostHello | null,
    reason: string | null,
    errorCode: string | null,
  ): void {
    const next = freezeSshConnectionState({
      profileId: this.profile.id,
      topology: this.profile.topology,
      status,
      attempt,
      hello,
      reason,
      errorCode,
    });
    if (sameState(this.stateValue, next)) return;
    this.stateValue = next;
    for (const listener of this.listeners) {
      try {
        listener(this.snapshot());
      } catch {}
    }
  }
}

function sameState(left: SshConnectionState, right: SshConnectionState): boolean {
  return (
    left.profileId === right.profileId &&
    left.topology === right.topology &&
    left.status === right.status &&
    left.attempt === right.attempt &&
    left.reason === right.reason &&
    left.errorCode === right.errorCode &&
    JSON.stringify(left.hello) === JSON.stringify(right.hello)
  );
}
