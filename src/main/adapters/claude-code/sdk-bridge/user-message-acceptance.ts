import type { AgentEvent } from '@shared/types';
import { AGENT_ID } from './constants';
import type { InternalSession } from './types';
import {
  confirmClaudeUserMessageAcceptanceCore,
  discardClaudeSubmittingUserMessageCore,
  rememberIgnoredClaudeUserMessageIdCore,
} from './user-message-acceptance-core';

const desktopClaudeUserMessageAcceptanceHost = {
  agentId: AGENT_ID,
  now: () => Date.now(),
};

export function confirmClaudeUserMessageAcceptance(
  emit: (event: AgentEvent) => void,
  sessionId: string,
  msg: { type: string; uuid?: unknown; parent_tool_use_id?: unknown },
  internal: InternalSession,
): void {
  confirmClaudeUserMessageAcceptanceCore(
    emit,
    sessionId,
    msg,
    internal,
    desktopClaudeUserMessageAcceptanceHost,
  );
}

export const discardClaudeSubmittingUserMessage =
  discardClaudeSubmittingUserMessageCore;

export const rememberIgnoredClaudeUserMessageId =
  rememberIgnoredClaudeUserMessageIdCore;
