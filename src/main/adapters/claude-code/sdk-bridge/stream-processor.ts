/** Stable desktop facade for the host-neutral Claude provider stream processor. */
import {
  ClaudeStreamProcessorCore,
  type ClaudeStreamProcessorContext,
} from './stream-processor-core';
import {
  createDesktopClaudeStreamProcessorHost,
  type ClaudeStreamSessionManagerPort,
} from './stream-processor-host';

export type StreamProcessorCtx = ClaudeStreamProcessorContext;

export class StreamProcessor extends ClaudeStreamProcessorCore {
  constructor(ctx: StreamProcessorCtx, sessionManager: ClaudeStreamSessionManagerPort) {
    super(ctx, createDesktopClaudeStreamProcessorHost(sessionManager));
  }
}
