import { desktopClaudeSdkMessageTranslationHost } from './sdk-message-translate';
import { createDesktopClaudeStreamFinalizeHost } from './stream-finalize-host';
import { createDesktopClaudeStreamSessionIdentityHost } from './stream-session-identity-host';
import type { ClaudeStreamProcessorHost } from './stream-processor-core';
import { desktopClaudeStreamWaitHost } from './stream-wait-host';
import { desktopClaudeUserMessageStreamHost } from './user-message-stream-host';
import type { ClaudeSessionManagerPort } from '../session-manager-core';

export type ClaudeStreamSessionManagerPort = Pick<
  ClaudeSessionManagerPort,
  'releaseSdkClaim' | 'renameSdkSession' | 'updateCliSessionId'
>;

export function createDesktopClaudeStreamProcessorHost(
  sessionManager: ClaudeStreamSessionManagerPort,
): ClaudeStreamProcessorHost {
  return {
    ...desktopClaudeStreamWaitHost,
    userMessages: desktopClaudeUserMessageStreamHost,
    translation: desktopClaudeSdkMessageTranslationHost,
    finalize: createDesktopClaudeStreamFinalizeHost(sessionManager),
    identity: createDesktopClaudeStreamSessionIdentityHost(sessionManager),
  };
}
