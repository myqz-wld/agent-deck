import type { AgentEvent } from '@shared/types';
import { AGENT_ID } from './constants';
import { desktopClaudeLiveRateHost } from './live-token-rate-host';
import { desktopClaudeRuntimeMetadataHost } from './runtime-metadata-host';
import { desktopClaudeMessageTranslationStateHost } from './message-translation-state-host';
import {
  translateSdkMessageCore,
  type ClaudeSdkMessageTranslationHost,
} from './sdk-message-translate-core';
import type { InternalSession } from './types';
import log from '@main/utils/logger';

const logger = log.scope('claude-input');

export const desktopClaudeSdkMessageTranslationHost: ClaudeSdkMessageTranslationHost = {
  agentId: AGENT_ID,
  now: () => Date.now(),
  observeSlowAcceptance: (timing) => logger.info('Claude input acceptance delayed', timing),
  runtimeMetadata: desktopClaudeRuntimeMetadataHost,
  liveRate: desktopClaudeLiveRateHost,
  state: desktopClaudeMessageTranslationStateHost,
};

export function translateSdkMessage(
  emit: (event: AgentEvent) => void,
  sessionId: string,
  msg: { type: string; [key: string]: unknown },
  internal: InternalSession,
): void {
  translateSdkMessageCore(
    emit,
    sessionId,
    msg,
    internal,
    desktopClaudeSdkMessageTranslationHost,
  );
}

export {
  consumePendingFileChangeIntentCore as consumePendingFileChangeIntent,
  pushFileChangeIntentCore as pushFileChangeIntent,
} from './message-file-changes-core';
