import { AgentDeckClientErrorCode } from '@contracts/index';
import type { HostHello } from '@contracts/index';
import type { HostProtocolMessage, ProtocolMessage } from '@protocol/messages';

import type { ConnectionContext } from './connection-context';
import { remoteErrorFromMessage } from './errors';
import { isBoundedSingleLine, SSH_TEXT_LIMITS } from './limits';

export type RoutedTerminalStatus = 'incompatible' | 'offline';

export interface HostMessageRoutes {
  completeHandshake(hello: HostHello): void;
  deliver(message: HostProtocolMessage): void;
  sendPong(nonce: string): void;
  acceptPong(nonce: string): void;
  fail(error: Error, status: RoutedTerminalStatus): void;
  invalid(detail: string): void;
}

export function routeHostProtocolMessage(
  context: ConnectionContext,
  message: ProtocolMessage,
  routes: HostMessageRoutes,
): void {
  if (!context.handshakeComplete) {
    if (
      (message.type === 'hello-result' || message.type === 'error') &&
      !acceptHostIdentifier(message.requestId, 'handshake requestId', routes)
    ) {
      return;
    }
    if (message.type === 'hello-result' && message.requestId === context.helloRequestId) {
      routes.completeHandshake(message.hello);
      return;
    }
    if (message.type === 'error' && message.requestId === context.helloRequestId) {
      const error = remoteErrorFromMessage(message);
      routes.fail(
        error,
        error.code === AgentDeckClientErrorCode.IncompatibleProtocol ||
          error.code === AgentDeckClientErrorCode.Revoked
          ? 'incompatible'
          : 'offline',
      );
      return;
    }
    routes.invalid('unexpected message before hello-result');
    return;
  }

  switch (message.type) {
    case 'result':
    case 'error':
      if (!acceptHostIdentifier(message.requestId, 'response requestId', routes)) return;
      routes.deliver(message);
      return;
    case 'event':
      routes.deliver(message);
      return;
    case 'ping':
      if (!acceptHostIdentifier(message.nonce, 'ping nonce', routes)) return;
      routes.sendPong(message.nonce);
      return;
    case 'pong':
      if (!acceptHostIdentifier(message.nonce, 'pong nonce', routes)) return;
      routes.acceptPong(message.nonce);
      return;
    default:
      routes.invalid(`invalid host message ${message.type}`);
  }
}

function acceptHostIdentifier(
  value: string,
  field: string,
  routes: HostMessageRoutes,
): boolean {
  if (isBoundedSingleLine(value, SSH_TEXT_LIMITS.requestId)) return true;
  routes.invalid(`invalid ${field}`);
  return false;
}
