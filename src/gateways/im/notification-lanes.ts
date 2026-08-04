import { FeishuNotificationLane } from './delivery';
import { FeishuGatewayLifecycleError } from './errors';
import type {
  EnrolledFeishuCredential,
  FeishuGatewayObserver,
  NotificationEvent,
} from './types';

export class FeishuNotificationLanes {
  private readonly lanes = new Map<string, FeishuNotificationLane>();

  constructor(
    private readonly maximumLanes: number,
    private readonly maximumQueued: number,
    private readonly isOpen: () => boolean,
    private readonly consume: (
      credential: EnrolledFeishuCredential,
      chatId: string,
      event: NotificationEvent,
    ) => Promise<void>,
    private readonly observer: FeishuGatewayObserver | undefined,
    private readonly onFailure: (
      credential: EnrolledFeishuCredential,
      chatId: string,
      epoch: number,
    ) => void,
  ) {}

  private key(credential: EnrolledFeishuCredential, chatId: string): string {
    return `${credential.instanceId}\u001f${credential.credentialId}\u001f${chatId}`;
  }

  prepare(credential: EnrolledFeishuCredential, chatId: string, epoch: number): boolean {
    if (!this.isOpen()) return false;
    const key = this.key(credential, chatId);
    let lane = this.lanes.get(key);
    if (!lane) {
      if (this.lanes.size >= this.maximumLanes) return false;
      lane = new FeishuNotificationLane(
        chatId,
        this.maximumQueued,
        (event) => this.consume(credential, chatId, event),
        this.observer,
        (failedEpoch) => this.onFailure(credential, chatId, failedEpoch),
      );
      this.lanes.set(key, lane);
    }
    return lane.prepare(epoch);
  }

  push(
    credential: EnrolledFeishuCredential,
    chatId: string,
    epoch: number,
    event: NotificationEvent,
  ): boolean {
    return this.lanes.get(this.key(credential, chatId))?.push(epoch, event) ?? false;
  }

  activate(credential: EnrolledFeishuCredential, chatId: string, epoch: number): boolean {
    return this.lanes.get(this.key(credential, chatId))?.activate(epoch) ?? false;
  }

  start(credential: EnrolledFeishuCredential, chatId: string, epoch: number): void {
    this.lanes.get(this.key(credential, chatId))?.start(epoch);
  }

  async retire(
    credential: EnrolledFeishuCredential,
    chatId: string,
    epoch: number,
  ): Promise<void> {
    const key = this.key(credential, chatId);
    const lane = this.lanes.get(key);
    if (!lane || !await lane.retire(epoch)) return;
    await lane.close();
    if (this.lanes.get(key) === lane) this.lanes.delete(key);
  }

  async close(): Promise<void> {
    const results = await Promise.allSettled([...this.lanes.values()].map((lane) => lane.close()));
    const failures = results
      .filter((result): result is PromiseRejectedResult => result.status === 'rejected')
      .map((result) => result.reason);
    if (failures.length > 0) throw new FeishuGatewayLifecycleError(failures, 'close');
    this.lanes.clear();
  }
}
