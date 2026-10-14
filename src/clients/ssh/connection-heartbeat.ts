import type { ConnectionContext } from './connection-context';
import { ProtocolHeartbeat } from './heartbeat';
import { SshTransportError } from './errors';
import type { SshTransportOptions, SshTransportTiming } from './types';

export function createConnectionHeartbeat(input: {
  profileId: string;
  timing: SshTransportTiming;
  options: SshTransportOptions;
  context(): ConnectionContext | null;
  createNonce(): string;
  fail(context: ConnectionContext | null, error: Error): void;
}): ProtocolHeartbeat {
  return new ProtocolHeartbeat(input.timing, input.createNonce, (nonce, onWritten) => {
    const context = input.context();
    if (!context?.handshakeComplete || context.terminated) {
      throw new SshTransportError('not_connected', 'SSH protocol connection is not ready');
    }
    context.writer.enqueue({ type: 'ping', nonce }, onWritten);
  }, (details) => {
    const context = input.context();
    try {
      input.options.onHeartbeatTimeout?.({
        ...details, ...context?.writer.diagnosticSnapshot(),
        profileId: input.profileId, generation: context?.generation ?? 0,
      });
    } catch { /* Diagnostic sinks cannot change reconnection behavior. */ }
    input.fail(context, new SshTransportError('connection_failed', 'SSH protocol pong timed out', true));
  }, input.options.now ?? Date.now);
}
