import { FeishuGatewayError } from './errors';
import type {
  FeishuSessionDeleteClaim,
  FeishuSessionDeleteConfirmation,
} from './types';

function key(instanceId: string, confirmationId: string): string {
  return `${instanceId}\u001f${confirmationId}`;
}

function copy(
  value: FeishuSessionDeleteConfirmation,
): FeishuSessionDeleteConfirmation {
  return { ...value };
}

function safeDeadline(now: number, lifetimeMs: number): number {
  if (
    !Number.isSafeInteger(now) || now < 0 ||
    !Number.isSafeInteger(lifetimeMs) || lifetimeMs <= 0
  ) {
    throw new FeishuGatewayError(
      'invalid_configuration',
      'Delete confirmation claim lifetime is invalid',
    );
  }
  return Math.min(Number.MAX_SAFE_INTEGER, now + lifetimeMs);
}

/** In-memory confirmation ledger used only by deterministic gateway tests. */
export class InMemoryFeishuDeleteConfirmationStore {
  private readonly records = new Map<string, FeishuSessionDeleteConfirmation>();

  constructor(
    private readonly onComplete: (value: FeishuSessionDeleteConfirmation) => void,
  ) {}

  create(
    input: FeishuSessionDeleteConfirmation,
  ): FeishuSessionDeleteConfirmation {
    if (
      input.status !== 'pending' || input.claimEventId !== null ||
      input.claimExpiresAt !== null || input.expiresAt <= input.createdAt ||
      input.updatedAt !== input.createdAt
    ) {
      throw new FeishuGatewayError(
        'invalid_configuration',
        'Delete confirmation metadata is invalid',
      );
    }
    if (this.records.has(key(input.instanceId, input.confirmationId))) {
      throw new FeishuGatewayError('identity_conflict', 'Delete confirmation id already exists');
    }
    for (const value of this.records.values()) {
      if (
        value.instanceId === input.instanceId &&
        value.tokenHash === input.tokenHash
      ) {
        throw new FeishuGatewayError('identity_conflict', 'Delete confirmation token already exists');
      }
      if (
        value.instanceId !== input.instanceId ||
        value.credentialId !== input.credentialId ||
        value.chatId !== input.chatId ||
        !['pending', 'executing'].includes(value.status)
      ) continue;
      if (
        value.status === 'executing' &&
        value.claimExpiresAt !== null &&
        value.claimExpiresAt > input.createdAt
      ) {
        throw new FeishuGatewayError(
          'event_in_progress',
          'A session deletion confirmation is already executing',
          true,
        );
      }
      this.records.set(key(value.instanceId, value.confirmationId), {
        ...value,
        status: 'expired',
        claimEventId: null,
        claimExpiresAt: null,
        updatedAt: input.createdAt,
      });
    }
    const created = copy(input);
    this.records.set(key(input.instanceId, input.confirmationId), created);
    return copy(created);
  }

  claim(input: {
    instanceId: string;
    credentialId: string;
    chatId: string;
    openId: string;
    tokenHash: string;
    eventId: string;
    now: number;
    claimLifetimeMs: number;
  }): FeishuSessionDeleteClaim {
    const value = [...this.records.values()].find((candidate) =>
      candidate.instanceId === input.instanceId && candidate.tokenHash === input.tokenHash);
    if (
      !value || value.credentialId !== input.credentialId ||
      value.chatId !== input.chatId || value.openId !== input.openId
    ) return { state: 'invalid', record: null };
    if (value.status === 'completed') return { state: 'completed', record: copy(value) };
    if (value.status === 'expired' || input.now >= value.expiresAt) {
      const expired = {
        ...value,
        status: 'expired' as const,
        claimEventId: null,
        claimExpiresAt: null,
        updatedAt: input.now,
      };
      this.records.set(key(value.instanceId, value.confirmationId), expired);
      return { state: 'expired', record: copy(expired) };
    }
    if (
      value.status === 'executing' &&
      value.claimEventId !== input.eventId &&
      value.claimExpiresAt !== null &&
      input.now < value.claimExpiresAt
    ) return { state: 'in-progress', record: copy(value) };
    const claimed = {
      ...value,
      status: 'executing' as const,
      claimEventId: input.eventId,
      claimExpiresAt: safeDeadline(input.now, input.claimLifetimeMs),
      updatedAt: input.now,
    };
    this.records.set(key(value.instanceId, value.confirmationId), claimed);
    return { state: 'claimed', record: copy(claimed) };
  }

  release(
    instanceId: string,
    confirmationId: string,
    eventId: string,
    updatedAt: number,
  ): boolean {
    const current = this.records.get(key(instanceId, confirmationId));
    if (
      !current || current.status !== 'executing' ||
      current.claimEventId !== eventId
    ) return false;
    this.records.set(key(instanceId, confirmationId), {
      ...current,
      status: 'pending',
      claimEventId: null,
      claimExpiresAt: null,
      updatedAt,
    });
    return true;
  }

  complete(
    instanceId: string,
    confirmationId: string,
    eventId: string,
    updatedAt: number,
  ): boolean {
    const current = this.records.get(key(instanceId, confirmationId));
    if (
      !current || current.status !== 'executing' ||
      current.claimEventId !== eventId
    ) return false;
    const completed = {
      ...current,
      status: 'completed' as const,
      claimExpiresAt: null,
      updatedAt,
    };
    this.records.set(key(instanceId, confirmationId), completed);
    this.onComplete(completed);
    return true;
  }

  get(instanceId: string, confirmationId: string): FeishuSessionDeleteConfirmation | null {
    const value = this.records.get(key(instanceId, confirmationId));
    return value ? copy(value) : null;
  }

  prune(terminalBefore: number, now: number): number {
    let removed = 0;
    for (const [recordKey, value] of this.records) {
      if (
        ['pending', 'executing'].includes(value.status) &&
        now >= value.expiresAt
      ) {
        this.records.set(recordKey, {
          ...value,
          status: 'expired',
          claimEventId: null,
          claimExpiresAt: null,
          updatedAt: now,
        });
      }
      const current = this.records.get(recordKey) as FeishuSessionDeleteConfirmation;
      if (
        ['completed', 'expired'].includes(current.status) &&
        current.updatedAt < terminalBefore
      ) {
        this.records.delete(recordKey);
        removed += 1;
      }
    }
    return removed;
  }

  values(): readonly FeishuSessionDeleteConfirmation[] {
    return [...this.records.values()].map(copy);
  }
}
