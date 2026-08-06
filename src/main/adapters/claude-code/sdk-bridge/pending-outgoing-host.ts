import { rememberIgnoredClaudeUserMessageIdCore } from './user-message-acceptance-core';
import type { ClaudePendingOutgoingHost } from './pending-outgoing-core';

export const desktopClaudePendingOutgoingHost: ClaudePendingOutgoingHost = {
  rememberIgnoredUserMessageId: rememberIgnoredClaudeUserMessageIdCore,
};
