import {
  relayRouteFrameWireBytes,
  type RelayRouteFrame,
  type RelayRouteFrameLimits,
} from '@protocol/relay';

interface QueuedFrame {
  frame: RelayRouteFrame;
  bytes: number;
}

function cloneFrame(frame: RelayRouteFrame): RelayRouteFrame {
  return { ...frame, payload: frame.payload.slice() };
}

export class BoundedRelayFrameQueue {
  private readonly items: QueuedFrame[] = [];
  private readonly streamBytes = new Map<string, number>();
  private total = 0;

  constructor(
    readonly maxBytesPerStream: number,
    readonly maxTotalBytes: number,
    readonly frameLimits: RelayRouteFrameLimits,
  ) {
    for (const [name, value] of [
      ['maxBytesPerStream', maxBytesPerStream],
      ['maxTotalBytes', maxTotalBytes],
    ] as const) {
      if (!Number.isSafeInteger(value) || value <= 0) {
        throw new RangeError(`${name} must be a positive safe integer`);
      }
    }
    if (maxBytesPerStream > maxTotalBytes) {
      throw new RangeError('maxBytesPerStream cannot exceed maxTotalBytes');
    }
  }

  get totalBytes(): number {
    return this.total;
  }

  get length(): number {
    return this.items.length;
  }

  bytesForStream(streamId: string): number {
    return this.streamBytes.get(streamId) ?? 0;
  }

  enqueue(frame: RelayRouteFrame): boolean {
    const storedFrame = cloneFrame(frame);
    const bytes = relayRouteFrameWireBytes(storedFrame, this.frameLimits);
    const nextStreamBytes = this.bytesForStream(storedFrame.streamId) + bytes;
    if (nextStreamBytes > this.maxBytesPerStream || this.total + bytes > this.maxTotalBytes) {
      return false;
    }
    this.items.push({ frame: storedFrame, bytes });
    this.streamBytes.set(storedFrame.streamId, nextStreamBytes);
    this.total += bytes;
    return true;
  }

  drain(maxBytes = Number.MAX_SAFE_INTEGER): RelayRouteFrame[] {
    return this.drainByCost(maxBytes, (_frame, storedBytes) => storedBytes);
  }

  drainByCost(
    maxBytes: number,
    cost: (frame: RelayRouteFrame, storedBytes: number) => number,
  ): RelayRouteFrame[] {
    if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0) {
      throw new RangeError('maxBytes must be a positive safe integer');
    }
    const frames: RelayRouteFrame[] = [];
    let drainedBytes = 0;
    while (this.items.length > 0) {
      const next = this.items[0];
      const delivery = cloneFrame(next.frame);
      const nextCost = cost(delivery, next.bytes);
      if (!Number.isSafeInteger(nextCost) || nextCost <= 0) {
        throw new RangeError('Queue drain cost must be a positive safe integer');
      }
      if (drainedBytes + nextCost > maxBytes) break;
      this.items.shift();
      frames.push(delivery);
      drainedBytes += nextCost;
      this.total -= next.bytes;
      const remaining = this.bytesForStream(next.frame.streamId) - next.bytes;
      if (remaining === 0) this.streamBytes.delete(next.frame.streamId);
      else this.streamBytes.set(next.frame.streamId, remaining);
    }
    return frames;
  }

  dropStream(streamId: string): void {
    if (!this.streamBytes.has(streamId)) return;
    for (let index = this.items.length - 1; index >= 0; index -= 1) {
      const item = this.items[index];
      if (item.frame.streamId !== streamId) continue;
      this.total -= item.bytes;
      this.items.splice(index, 1);
    }
    this.streamBytes.delete(streamId);
  }

  clear(): void {
    this.items.length = 0;
    this.streamBytes.clear();
    this.total = 0;
  }
}
