import type {
  ContextRuntimeIdentityEvidence,
  ContextWindowCapacityEvidence,
} from '@shared/types';
import {
  CodexAppServerTurnError,
  readTerminalError,
  readCompletedAgentMessageText,
} from './notification-helpers';
import type {
  CodexAppServerRunResult,
  CodexAppServerStreamEvent,
} from './protocol';
import { readCodexContextWindowTokens } from './token-usage-translate';

export async function collectCodexTurnOutput(
  events: AsyncIterable<CodexAppServerStreamEvent>,
  maxOutputBytes: number | undefined,
): Promise<CodexAppServerRunResult> {
  const messages: string[] = [];
  let contextWindowEvidence: CodexAppServerRunResult['contextWindowEvidence'] = null;
  for await (const event of events) {
    if (event.type !== 'server.notification') continue;
    const terminalError = readTerminalError(event.notification);
    if (terminalError) {
      throw new CodexAppServerTurnError(
        terminalError.message,
        terminalError.codexErrorInfo,
      );
    }
    if (
      contextWindowEvidence &&
      !capacityEvidenceMatchesIdentity(contextWindowEvidence, event.runtimeIdentity)
    ) {
      contextWindowEvidence = null;
    }
    const contextWindowTokens = readCodexContextWindowTokens(
      event.notification.params,
    );
    if (contextWindowTokens !== null && event.runtimeIdentity) {
      contextWindowEvidence = {
        ...event.runtimeIdentity,
        windowTokens: contextWindowTokens,
        source: 'runtime-usage',
      };
    }
    const text = readCompletedAgentMessageText(event.notification);
    if (!text) continue;
    messages.push(text);
    if (
      maxOutputBytes !== undefined &&
      Buffer.byteLength(messages.join('\n'), 'utf8') > maxOutputBytes
    ) {
      throw new Error('Codex app-server output exceeded byte limit');
    }
  }
  return { finalResponse: messages.join('\n'), contextWindowEvidence };
}

function capacityEvidenceMatchesIdentity(
  evidence: ContextWindowCapacityEvidence,
  identity: ContextRuntimeIdentityEvidence | null,
): boolean {
  return identity !== null &&
    evidence.runtimeProvider === identity.runtimeProvider &&
    evidence.model === identity.model &&
    (evidence.capacityConfigFingerprint ?? null) ===
      (identity.capacityConfigFingerprint ?? null);
}
