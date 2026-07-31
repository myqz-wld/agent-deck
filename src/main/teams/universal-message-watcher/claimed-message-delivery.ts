import type { AgentAdapter } from '@main/adapters/types';
import { adapterRegistry } from '@main/adapters/registry';
import { sessionRepo } from '@main/store/session-repo';
import {
  agentDeckMessageRepo,
  type MessageDeliveryLease,
} from '@main/store/agent-deck-message-repo';
import {
  MAX_RETRY,
  MESSAGE_DELIVERY_DURABILITY,
} from '@main/store/message-delivery-state';
import { agentDeckTeamRepo } from '@main/store/agent-deck-team-repo';
import log from '@main/utils/logger';
import { sanitizeWireFieldName } from '@shared/wire-prefix';
import type { AgentDeckMessage } from '@shared/types';

const logger = log.scope('universal-message-watcher');

function resolveFromDisplayName(
  fromSessionId: string,
  teamId: string | null,
): { displayName: string; adapterId: string } {
  const session = sessionRepo.get(fromSessionId);
  const adapterId = session?.agentId ?? 'unknown-adapter';
  if (teamId !== null) {
    const membership = agentDeckTeamRepo.findActiveMembershipIn(teamId, fromSessionId);
    if (membership?.displayName?.trim()) {
      return { displayName: membership.displayName, adapterId };
    }
  } else if (session?.title?.trim()) {
    return { displayName: session.title, adapterId };
  }
  return {
    displayName: `${adapterId}:${fromSessionId.slice(0, 8)}`,
    adapterId,
  };
}

function buildWireBody(message: AgentDeckMessage): string {
  const { displayName, adapterId } = resolveFromDisplayName(
    message.fromSessionId,
    message.teamId,
  );
  return `[from ${sanitizeWireFieldName(displayName)} @ ${sanitizeWireFieldName(adapterId)}][msg ${message.id}][sid ${message.fromSessionId}]\n${message.body}`;
}

export interface DispatchClaimedMessageInput {
  claimed: AgentDeckMessage;
  lease: MessageDeliveryLease;
  emitStatus: (message: AgentDeckMessage) => void;
}

/**
 * Finish one immutable delivery lease. Every state transition uses the claim's destination and
 * generation, so neither handoff retargeting nor crash recovery can let a stale worker finalize it.
 */
export async function dispatchClaimedMessage(
  input: DispatchClaimedMessageInput,
): Promise<void> {
  const { claimed, lease, emitStatus } = input;
  const fail = (reason: string): void => {
    const failed = agentDeckMessageRepo.markFailed(lease, reason);
    if (failed) emitStatus(failed);
  };

  const target = sessionRepo.get(claimed.toSessionId);
  if (!target) {
    fail('target session not found');
    return;
  }
  if (target.lifecycle === 'closed') {
    fail('target session is closed');
    return;
  }
  if (target.archivedAt != null) {
    fail('target session archived');
    return;
  }
  const fromSession = sessionRepo.get(claimed.fromSessionId);
  if (!fromSession) {
    fail('from session not found');
    return;
  }
  if (fromSession.archivedAt != null) {
    fail('from session archived');
    return;
  }

  if (claimed.teamId !== null) {
    const team = agentDeckTeamRepo.get(claimed.teamId);
    if (!team) {
      fail('team not found');
      return;
    }
    if (team.archivedAt != null) {
      fail('team archived');
      return;
    }
    const fromMembership = agentDeckTeamRepo.findActiveMembershipIn(
      claimed.teamId,
      claimed.fromSessionId,
    );
    const toMembership = agentDeckTeamRepo.findActiveMembershipIn(
      claimed.teamId,
      claimed.toSessionId,
    );
    if (!fromMembership && !toMembership) {
      fail('from and to no longer active members of team');
      return;
    }
    if (!fromMembership) {
      fail('from no longer active member of team');
      return;
    }
    if (!toMembership) {
      fail('to no longer active member of team');
      return;
    }
  }

  let adapter: AgentAdapter | undefined;
  try {
    adapter = adapterRegistry.get(target.agentId);
  } catch {
    adapter = undefined;
  }
  if (!adapter) {
    fail(`adapter "${target.agentId}" not registered`);
    return;
  }
  if (!adapter.capabilities.canCollaborate || !adapter.receiveTeammateMessage) {
    fail(`adapter "${target.agentId}" does not support receiveTeammateMessage`);
    return;
  }

  const wireBody = buildWireBody(claimed);
  try {
    await adapter.receiveTeammateMessage(
      claimed.toSessionId,
      claimed.fromSessionId,
      wireBody,
      claimed.id,
    );
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    const updated = agentDeckMessageRepo.retryAfterFail(lease, reason, Date.now());
    if (updated) {
      emitStatus(updated);
      if (updated.status === 'pending') {
        logger.warn(
          `[universal-message-watcher] deliver failed (attempt ${updated.attemptCount}/${MAX_RETRY}) message=${updated.id}: ${reason}`,
        );
      } else {
        logger.warn(
          `[universal-message-watcher] deliver exhausted message=${updated.id}: ${reason}`,
        );
      }
    }
    return;
  }

  try {
    const delivered = agentDeckMessageRepo.markDelivered(lease, Date.now());
    if (delivered) emitStatus(delivered);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    logger.warn(
      `[universal-message-watcher] markDelivered failed after adapter accepted message=${claimed.id}; ${MESSAGE_DELIVERY_DURABILITY} policy forbids retry: ${reason}`,
    );
    try {
      fail(`post-delivery markDelivered failed after adapter accepted; not retried: ${reason}`);
    } catch (markFailedError) {
      logger.warn(
        `[universal-message-watcher] markFailed also failed after markDelivered failure message=${claimed.id}:`,
        markFailedError,
      );
    }
  }
}
