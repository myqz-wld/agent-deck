import type { InternalSession } from './types';
import {
  listClaudePendingOutgoingMessagesCore,
  removeClaudePendingOutgoingMessageCore,
  snapshotClaudeQueuedMessagesForHandOffCore,
} from './pending-outgoing-core';
import { rememberIgnoredClaudeUserMessageId } from './user-message-acceptance';

const desktopClaudePendingOutgoingHost = {
  rememberIgnoredUserMessageId: rememberIgnoredClaudeUserMessageId,
};

export const snapshotClaudeQueuedMessagesForHandOff =
  snapshotClaudeQueuedMessagesForHandOffCore;

export const listClaudePendingOutgoingMessages =
  listClaudePendingOutgoingMessagesCore;

export function removeClaudePendingOutgoingMessage(
  sessions: ReadonlyMap<string, InternalSession>,
  sessionId: string,
  messageId: string,
) {
  return removeClaudePendingOutgoingMessageCore(
    sessions,
    sessionId,
    messageId,
    desktopClaudePendingOutgoingHost,
  );
}
