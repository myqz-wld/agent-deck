import { randomUUID } from 'node:crypto';

import type {
  RequestPermissionRequest,
  RequestPermissionResponse,
} from '@agentclientprotocol/sdk';
import type {
  AgentEvent,
  PermissionRequest,
  PermissionResponse,
} from '@shared/types';

import { asRecord } from './protocol-utils';
import type { GrokRuntime } from './runtime-types';

export class GrokPermissionController {
  constructor(
    private permissionTimeoutMs: number,
    private readonly emitEvent: (
      sessionId: string,
      kind: AgentEvent['kind'],
      payload: unknown,
    ) => void,
  ) {}

  setTimeoutMs(ms: number): void {
    this.permissionTimeoutMs = ms;
  }

  handle(
    runtime: GrokRuntime,
    request: RequestPermissionRequest,
    signal: AbortSignal,
  ): Promise<RequestPermissionResponse> {
    if (runtime.closed) return Promise.resolve({ outcome: { outcome: 'cancelled' } });
    const requestId = randomUUID();
    const permission: PermissionRequest = {
      type: 'permission-request',
      requestId,
      toolName: request.toolCall.title ?? 'Grok tool',
      toolInput: asRecord(request.toolCall.rawInput),
      ...(request.options.some((option) => option.kind === 'allow_always')
        ? { suggestions: request.options }
        : {}),
    };
    return new Promise<RequestPermissionResponse>((resolve) => {
      const finishCancelled = () => {
        const pending = runtime.pendingPermissions.get(requestId);
        if (!pending) return;
        runtime.pendingPermissions.delete(requestId);
        if (pending.timer) clearTimeout(pending.timer);
        this.emitCancelled(runtime.applicationSessionId, requestId);
        resolve({ outcome: { outcome: 'cancelled' } });
      };
      const timer =
        this.permissionTimeoutMs > 0
          ? setTimeout(finishCancelled, this.permissionTimeoutMs)
          : null;
      runtime.pendingPermissions.set(requestId, {
        request: permission,
        options: request.options,
        resolve,
        timer,
      });
      signal.addEventListener('abort', finishCancelled, { once: true });
      this.emitEvent(runtime.applicationSessionId, 'waiting-for-user', permission);
    });
  }

  respond(
    runtime: GrokRuntime | undefined,
    requestId: string,
    response: PermissionResponse,
  ): void {
    const pending = runtime?.pendingPermissions.get(requestId);
    if (!runtime || !pending) return;
    runtime.pendingPermissions.delete(requestId);
    if (pending.timer) clearTimeout(pending.timer);
    const preferred =
      response.decision === 'allow'
        ? response.updatedPermissions
          ? ['allow_always', 'allow_once']
          : ['allow_once', 'allow_always']
        : ['reject_once', 'reject_always'];
    const option = preferred
      .map((kind) => pending.options.find((candidate) => candidate.kind === kind))
      .find(Boolean);
    pending.resolve(
      option
        ? { outcome: { outcome: 'selected', optionId: option.optionId } }
        : { outcome: { outcome: 'cancelled' } },
    );
  }

  list(runtime: GrokRuntime | undefined): PermissionRequest[] {
    return [...(runtime?.pendingPermissions.values() ?? [])].map(
      (pending) => pending.request,
    );
  }

  cancel(runtime: GrokRuntime): void {
    for (const [requestId, pending] of runtime.pendingPermissions) {
      if (pending.timer) clearTimeout(pending.timer);
      this.emitCancelled(runtime.applicationSessionId, requestId);
      pending.resolve({ outcome: { outcome: 'cancelled' } });
    }
    runtime.pendingPermissions.clear();
  }

  private emitCancelled(sessionId: string, requestId: string): void {
    this.emitEvent(sessionId, 'waiting-for-user', {
      type: 'permission-cancelled',
      requestId,
    });
  }
}
