import type { PermissionRequest, PermissionResponse } from '@shared/types';

import type { CodexAppServerClient } from '../app-server/client';
import type {
  CodexAppServerServerRequest,
  CodexAppServerServerRequestDisposition,
} from '../app-server/protocol';
import { CodexPermissionController } from './permission-controller';
import type { CodexBridgeOptions, InternalSession } from './types';

type PendingShape = {
  permissions: PermissionRequest[];
  askQuestions: never[];
  exitPlanModes: never[];
};

interface PermissionHostContext {
  sessions: ReadonlyMap<string, InternalSession>;
  clients: ReadonlyMap<string, CodexAppServerClient>;
  timeoutMs: number;
  emit: CodexBridgeOptions['emit'];
}

/** Connects per-process server requests to the matching Agent Deck session permission queue. */
export class CodexPermissionHost {
  private readonly controller: CodexPermissionController;

  constructor(private readonly ctx: PermissionHostContext) {
    this.controller = new CodexPermissionController(ctx.timeoutMs, ctx.emit);
  }

  bindClient(client: CodexAppServerClient): void {
    // Narrow embedding/test doubles may predate host-initiated requests.
    client.setServerRequestHandler?.((request, signal) =>
      this.handle(client, request, signal));
  }

  cancel(internal: InternalSession): void {
    this.controller.cancel(internal);
  }

  respond(
    sessionId: string,
    requestId: string,
    response: PermissionResponse,
  ): void {
    this.controller.respond(this.findSession(sessionId) ?? undefined, requestId, response);
  }

  list(sessionId: string): PermissionRequest[] {
    return this.controller.list(this.findSession(sessionId) ?? undefined);
  }

  listAll(): Record<string, PendingShape> {
    const out: Record<string, PendingShape> = {};
    for (const internal of new Set(this.ctx.sessions.values())) {
      const permissions = this.controller.list(internal);
      if (permissions.length > 0) {
        out[internal.applicationSid] = {
          permissions,
          askQuestions: [],
          exitPlanModes: [],
        };
      }
    }
    return out;
  }

  setTimeoutMs(ms: number): void {
    this.controller.setTimeoutMs(ms);
  }

  private handle(
    client: CodexAppServerClient,
    request: CodexAppServerServerRequest,
    signal: AbortSignal,
  ): Promise<CodexAppServerServerRequestDisposition> | CodexAppServerServerRequestDisposition {
    return this.controller.handle(
      this.resolveClientSession(client, request),
      request,
      signal,
    );
  }

  private resolveClientSession(
    client: CodexAppServerClient,
    request: CodexAppServerServerRequest,
  ): InternalSession | null {
    const params =
      request.params && typeof request.params === 'object' && !Array.isArray(request.params)
        ? request.params as Record<string, unknown>
        : {};
    const nativeId =
      typeof params.threadId === 'string'
        ? params.threadId
        : typeof params.conversationId === 'string'
          ? params.conversationId
          : null;
    for (const [key, internal] of this.ctx.sessions) {
      if (
        nativeId !== null &&
        internal.threadId !== nativeId &&
        internal.applicationSid !== nativeId
      ) {
        continue;
      }
      if (
        this.ctx.clients.get(key) === client ||
        this.ctx.clients.get(internal.applicationSid) === client ||
        (internal.threadId !== null && this.ctx.clients.get(internal.threadId) === client)
      ) {
        return internal;
      }
    }
    return null;
  }

  private findSession(sessionId: string): InternalSession | null {
    const direct = this.ctx.sessions.get(sessionId);
    if (direct) return direct;
    for (const internal of this.ctx.sessions.values()) {
      if (internal.applicationSid === sessionId || internal.threadId === sessionId) {
        return internal;
      }
    }
    return null;
  }
}
