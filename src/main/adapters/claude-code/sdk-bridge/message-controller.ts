import {
  sendClaudeMessageCore,
  type ClaudeMessageControllerContext,
  type ClaudeMessageInput,
} from './message-controller-core';
import { desktopClaudeMessageControllerHost } from './message-controller-host';

export type {
  ClaudeMessageControllerContext,
  ClaudeMessageInput,
} from './message-controller-core';

export function sendClaudeMessage(
  context: ClaudeMessageControllerContext,
  input: ClaudeMessageInput,
): Promise<void> {
  return sendClaudeMessageCore(context, input, desktopClaudeMessageControllerHost);
}
