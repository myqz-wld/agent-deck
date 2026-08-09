import { assertProtocolMessageEnvelope, type ProtocolMessage } from '@protocol/messages';

import type { ConnectionContext } from './connection-context';
import { isHostKeyFailure } from './errors';
import { toSshStreamBytes } from './process';

export function decodeSshStdout(
  context: ConnectionContext,
  chunk: unknown,
  onMessage: (message: ProtocolMessage) => void,
): void {
  const bytes = toSshStreamBytes(chunk);
  for (const value of context.decoder.push(bytes)) {
    assertProtocolMessageEnvelope(value);
    onMessage(value as ProtocolMessage);
    if (context.terminated) break;
  }
}

export function captureSshStderr(
  context: ConnectionContext,
  chunk: unknown,
  maxBytes: number,
): void {
  const text =
    typeof chunk === 'string' ? chunk : new TextDecoder().decode(toSshStreamBytes(chunk));
  context.stderr = `${context.stderr}${text}`.slice(-maxBytes);
  context.hostKeyFailure ||= isHostKeyFailure(text) || isHostKeyFailure(context.stderr);
}
