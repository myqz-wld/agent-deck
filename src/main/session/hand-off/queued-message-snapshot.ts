import { isAgentId } from '@main/adapters/options-builder';
import { adapterRegistry } from '@main/adapters/registry';
import type { AgentAdapter, QueuedAgentMessage } from '@main/adapters/types';
import type { SessionRecord } from '@shared/types';

export type HandOffAdapterLookup = (
  agentId: SessionRecord['agentId'],
) => AgentAdapter | undefined;

/** Snapshot provider turns accepted before the handoff ingress lease started. */
export function snapshotHandOffQueuedMessages(
  source: SessionRecord,
  getAdapter: HandOffAdapterLookup = (agentId) =>
    isAgentId(agentId) ? adapterRegistry.get(agentId) : undefined,
): QueuedAgentMessage[] {
  if (!isAgentId(source.agentId)) return [];
  const messages = getAdapter(source.agentId)?.snapshotQueuedMessagesForHandOff?.(source.id) ?? [];
  return messages.map((message) => ({
    text: message.text,
    ...(message.attachments
      ? { attachments: message.attachments.map((attachment) => ({ ...attachment })) }
      : {}),
  }));
}
