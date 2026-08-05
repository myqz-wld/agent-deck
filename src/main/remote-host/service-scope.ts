import type { AgentDeckClient, CoreMethodMap } from '@contracts/index';

export interface RemoteHostScopedClient {
  client: AgentDeckClient<CoreMethodMap>;
  profileEpoch: number;
  profileId: string;
  sourceEpoch: number;
}

export class RemoteHostScopeEpochs {
  private sourceEpoch = 0;
  private readonly profileEpochs = new Map<string, number>();

  capture(profileId: string, client: AgentDeckClient<CoreMethodMap>): RemoteHostScopedClient {
    return {
      client,
      profileEpoch: this.profileEpoch(profileId),
      profileId,
      sourceEpoch: this.sourceEpoch,
    };
  }

  bumpProfile(profileId: string): void {
    this.profileEpochs.set(profileId, this.profileEpoch(profileId) + 1);
  }

  bumpSource(): void {
    this.sourceEpoch += 1;
  }

  captureSource(): number {
    return this.sourceEpoch;
  }

  isSourceCurrent(epoch: number): boolean {
    return epoch === this.sourceEpoch;
  }

  isCurrent(scope: RemoteHostScopedClient): boolean {
    return (
      scope.sourceEpoch === this.sourceEpoch &&
      scope.profileEpoch === this.profileEpoch(scope.profileId)
    );
  }

  private profileEpoch(profileId: string): number {
    return this.profileEpochs.get(profileId) ?? 0;
  }
}

export const REMOTE_HOST_INTERACTIVE_DEADLINE_MS = 45_000;
