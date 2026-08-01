import {
  readCompletedAgentMessageText,
  readTerminalErrorText,
} from './notification-helpers';
import type {
  CodexAppServerRunResult,
  CodexAppServerStreamEvent,
} from './protocol';

export async function collectCodexTurnOutput(
  events: AsyncIterable<CodexAppServerStreamEvent>,
  maxOutputBytes: number | undefined,
): Promise<CodexAppServerRunResult> {
  const messages: string[] = [];
  for await (const event of events) {
    if (event.type !== 'server.notification') continue;
    const terminalError = readTerminalErrorText(event.notification);
    if (terminalError) throw new Error(terminalError);
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
  return { finalResponse: messages.join('\n') };
}
