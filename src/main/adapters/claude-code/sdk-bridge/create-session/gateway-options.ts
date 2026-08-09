import type { CreateSessionOpts } from './_deps';
import { withResolvedClaudeGatewayCore } from '../session-defaults-core';
import { desktopClaudeSessionDefaultsHost } from '../session-defaults-host';

export function withResolvedClaudeGateway(opts: CreateSessionOpts): CreateSessionOpts {
  return withResolvedClaudeGatewayCore(opts, desktopClaudeSessionDefaultsHost);
}
