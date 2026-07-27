import { randomUUID } from 'node:crypto';

import type {
  CodexAppServerServerRequest,
  CodexAppServerServerRequestDisposition,
} from '../app-server/protocol';
import type { AgentEvent, PermissionRequest, PermissionResponse } from '@shared/types';
import type { CodexPendingPermission, InternalSession } from './types';
import { AGENT_ID } from './constants';

type ApprovalMethod =
  | 'item/commandExecution/requestApproval'
  | 'item/fileChange/requestApproval'
  | 'item/permissions/requestApproval'
  | 'execCommandApproval'
  | 'applyPatchApproval';

interface ParsedApproval {
  toolName: string;
  toolInput: Record<string, unknown>;
  supportsAlways: boolean;
  allow(always: boolean): unknown;
  deny(message?: string): unknown;
  cancel(timedOut: boolean): unknown;
}

const APPROVAL_METHODS = new Set<ApprovalMethod>([
  'item/commandExecution/requestApproval',
  'item/fileChange/requestApproval',
  'item/permissions/requestApproval',
  'execCommandApproval',
  'applyPatchApproval',
]);

export class CodexPermissionController {
  constructor(
    private permissionTimeoutMs: number,
    private readonly emit: (event: AgentEvent) => void,
  ) {}

  setTimeoutMs(ms: number): void {
    this.permissionTimeoutMs = Math.max(0, ms);
  }

  handle(
    internal: InternalSession | null,
    request: CodexAppServerServerRequest,
    signal: AbortSignal,
  ): Promise<CodexAppServerServerRequestDisposition> | CodexAppServerServerRequestDisposition {
    const approval = parseApproval(request);
    if (!approval) return { handled: false };
    if (!internal || internal.intentionallyClosed) {
      return { handled: true, result: approval.cancel(false) };
    }

    const requestId = randomUUID();
    const payload: PermissionRequest = {
      type: 'permission-request',
      requestId,
      toolName: approval.toolName,
      toolInput: approval.toolInput,
      ...(approval.supportsAlways ? { suggestions: { scope: 'session' } } : {}),
    };

    return new Promise<CodexAppServerServerRequestDisposition>((resolve) => {
      let timer: NodeJS.Timeout | null = null;
      const finish = (result: unknown, cancelled: boolean): void => {
        const current = internal.pendingPermissions.get(requestId);
        if (current !== pending) return;
        internal.pendingPermissions.delete(requestId);
        if (timer) clearTimeout(timer);
        signal.removeEventListener('abort', abort);
        if (cancelled) this.emitCancelled(internal.applicationSid, requestId);
        resolve({ handled: true, result });
      };
      const abort = (): void => finish(approval.cancel(false), true);
      const pending: CodexPendingPermission = {
        request: payload,
        respond: (response: PermissionResponse) => {
          const result =
            response.decision === 'allow'
              ? approval.allow(Boolean(response.updatedPermissions))
              : approval.deny(response.message);
          finish(result, false);
        },
        cancel: (reason) => finish(approval.cancel(reason === 'timed-out'), true),
      };

      internal.pendingPermissions.set(requestId, pending);
      signal.addEventListener('abort', abort, { once: true });
      if (this.permissionTimeoutMs > 0) {
        timer = setTimeout(() => pending.cancel('timed-out'), this.permissionTimeoutMs);
      }
      this.emit({
        sessionId: internal.applicationSid,
        agentId: AGENT_ID,
        kind: 'waiting-for-user',
        payload,
        ts: Date.now(),
        source: 'sdk',
      });
    });
  }

  respond(
    internal: InternalSession | undefined,
    requestId: string,
    response: PermissionResponse,
  ): void {
    internal?.pendingPermissions.get(requestId)?.respond(response);
  }

  list(internal: InternalSession | undefined): PermissionRequest[] {
    return [...(internal?.pendingPermissions.values() ?? [])].map((entry) => entry.request);
  }

  cancel(internal: InternalSession, reason: 'cancelled' | 'timed-out' = 'cancelled'): void {
    for (const pending of [...internal.pendingPermissions.values()]) {
      pending.cancel(reason);
    }
  }

  private emitCancelled(sessionId: string, requestId: string): void {
    this.emit({
      sessionId,
      agentId: AGENT_ID,
      kind: 'waiting-for-user',
      payload: { type: 'permission-cancelled', requestId },
      ts: Date.now(),
      source: 'sdk',
    });
  }
}

function parseApproval(request: CodexAppServerServerRequest): ParsedApproval | null {
  if (!APPROVAL_METHODS.has(request.method as ApprovalMethod)) return null;
  const params = asRecord(request.params);

  switch (request.method as ApprovalMethod) {
    case 'item/commandExecution/requestApproval': {
      const available = Array.isArray(params.availableDecisions)
        ? params.availableDecisions.filter((value): value is string => typeof value === 'string')
        : null;
      const supports = (decision: string): boolean =>
        available === null || available.includes(decision);
      return {
        toolName: 'Codex command',
        toolInput: params,
        supportsAlways: supports('acceptForSession'),
        allow: (always) => ({
          decision:
            always && supports('acceptForSession')
              ? 'acceptForSession'
              : supports('accept')
                ? 'accept'
                : supports('acceptForSession')
                  ? 'acceptForSession'
                  : 'decline',
        }),
        deny: () => ({ decision: 'decline' }),
        cancel: () => ({ decision: 'cancel' }),
      };
    }
    case 'item/fileChange/requestApproval':
      return {
        toolName: 'Codex file change',
        toolInput: params,
        supportsAlways: true,
        allow: (always) => ({ decision: always ? 'acceptForSession' : 'accept' }),
        deny: () => ({ decision: 'decline' }),
        cancel: () => ({ decision: 'cancel' }),
      };
    case 'item/permissions/requestApproval': {
      const requested = asRecord(params.permissions);
      const granted = compactGrantedPermissions(requested);
      return {
        toolName: 'Codex permission grant',
        toolInput: params,
        supportsAlways: true,
        allow: (always) => ({
          permissions: granted,
          scope: always ? 'session' : 'turn',
        }),
        deny: () => ({ permissions: {}, scope: 'turn' }),
        cancel: () => ({ permissions: {}, scope: 'turn' }),
      };
    }
    case 'execCommandApproval':
      return legacyApproval('Codex command', params);
    case 'applyPatchApproval':
      return legacyApproval('Codex file change', params);
  }
}

function legacyApproval(
  toolName: string,
  params: Record<string, unknown>,
): ParsedApproval {
  return {
    toolName,
    toolInput: params,
    supportsAlways: true,
    allow: (always) => ({ decision: always ? 'approved_for_session' : 'approved' }),
    deny: (message) => ({
      decision: { denied: { rejection: message?.trim() || 'Denied by user' } },
    }),
    cancel: (timedOut) => ({ decision: timedOut ? 'timed_out' : 'abort' }),
  };
}

function compactGrantedPermissions(
  requested: Record<string, unknown>,
): Record<string, unknown> {
  const granted: Record<string, unknown> = {};
  if (isRecord(requested.network)) granted.network = requested.network;
  if (isRecord(requested.fileSystem)) granted.fileSystem = requested.fileSystem;
  return granted;
}

function asRecord(value: unknown): Record<string, unknown> {
  return isRecord(value) ? { ...value } : {};
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}
