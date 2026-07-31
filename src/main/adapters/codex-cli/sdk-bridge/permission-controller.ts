import { randomUUID } from 'node:crypto';

import type {
  CodexAppServerServerRequest,
  CodexAppServerServerRequestDisposition,
} from '../app-server/protocol';
import { getAdapterRuntimeProfile } from '../../runtime-profiles';
import type { AgentEvent, PermissionRequest, PermissionResponse } from '@shared/types';
import type { CodexPendingPermission, InternalSession } from './types';
import { AGENT_ID } from './constants';

type ApprovalMethod =
  | 'item/commandExecution/requestApproval'
  | 'item/fileChange/requestApproval'
  | 'item/tool/requestUserInput'
  | 'item/permissions/requestApproval'
  | 'mcpServer/elicitation/request';

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
  'item/tool/requestUserInput',
  'item/permissions/requestApproval',
  'mcpServer/elicitation/request',
]);

const MCP_TOOL_APPROVAL_QUESTION_PREFIX = 'mcp_tool_call_approval_';
const MCP_TOOL_APPROVAL_KIND = 'mcp_tool_call';
const MCP_TOOL_ALLOW = 'Allow';
const MCP_TOOL_ALLOW_FOR_SESSION = 'Allow for this session';
const MCP_TOOL_DECLINE = '__codex_mcp_decline__';
const MCP_TOOL_CANCEL = 'Cancel';
const CODEX_CLI_DISPLAY_NAME = getAdapterRuntimeProfile(AGENT_ID).displayName;

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
        toolName: `${CODEX_CLI_DISPLAY_NAME} 命令`,
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
        toolName: `${CODEX_CLI_DISPLAY_NAME} 文件修改`,
        toolInput: params,
        supportsAlways: true,
        allow: (always) => ({ decision: always ? 'acceptForSession' : 'accept' }),
        deny: () => ({ decision: 'decline' }),
        cancel: () => ({ decision: 'cancel' }),
      };
    case 'item/tool/requestUserInput':
      return parseMcpToolRequestUserInput(params);
    case 'item/permissions/requestApproval': {
      const requested = asRecord(params.permissions);
      const granted = compactGrantedPermissions(requested);
      return {
        toolName: `${CODEX_CLI_DISPLAY_NAME} 权限授权`,
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
    case 'mcpServer/elicitation/request':
      return parseMcpToolElicitation(params);
  }
}

interface McpToolApprovalQuestion {
  id: string;
  header: string;
  question: string;
  options: Array<{ label: string; description: string }>;
  supportsSession: boolean;
}

function parseMcpToolRequestUserInput(
  params: Record<string, unknown>,
): ParsedApproval | null {
  if (!Array.isArray(params.questions) || params.questions.length === 0) return null;
  const questions: McpToolApprovalQuestion[] = [];
  for (const rawQuestion of params.questions) {
    const question = asRecord(rawQuestion);
    const id = typeof question.id === 'string' ? question.id : '';
    if (!id.startsWith(MCP_TOOL_APPROVAL_QUESTION_PREFIX)) return null;
    if (!Array.isArray(question.options)) return null;
    const options = question.options.flatMap((rawOption) => {
      const option = asRecord(rawOption);
      if (typeof option.label !== 'string') return [];
      return [{
        label: option.label,
        description: typeof option.description === 'string' ? option.description : '',
      }];
    });
    const labels = new Set(options.map((option) => option.label));
    if (!labels.has(MCP_TOOL_ALLOW) || !labels.has(MCP_TOOL_CANCEL)) return null;
    questions.push({
      id,
      header: typeof question.header === 'string' ? question.header : '',
      question: typeof question.question === 'string' ? question.question : '',
      options,
      supportsSession: labels.has(MCP_TOOL_ALLOW_FOR_SESSION),
    });
  }

  const answers = (labelFor: (question: McpToolApprovalQuestion) => string) => ({
    answers: Object.fromEntries(
      questions.map((question) => [
        question.id,
        { answers: [labelFor(question)] },
      ]),
    ),
  });
  const supportsAlways = questions.every((question) => question.supportsSession);
  return {
    toolName: `${CODEX_CLI_DISPLAY_NAME} MCP 工具调用`,
    toolInput: {
      itemId: params.itemId,
      questions: questions.map(({ header, question, options }) => ({
        header,
        question,
        options,
      })),
    },
    supportsAlways,
    allow: (always) =>
      answers((question) =>
        always && question.supportsSession
          ? MCP_TOOL_ALLOW_FOR_SESSION
          : MCP_TOOL_ALLOW),
    deny: () => answers(() => MCP_TOOL_DECLINE),
    cancel: () => ({ answers: {} }),
  };
}

function parseMcpToolElicitation(
  params: Record<string, unknown>,
): ParsedApproval | null {
  if (params.mode !== 'form' && params.mode !== 'openai/form') return null;
  const meta = asRecord(params._meta);
  if (meta.codex_approval_kind !== MCP_TOOL_APPROVAL_KIND) return null;
  const persist = meta.persist;
  const supportsAlways =
    persist === 'session' ||
    (Array.isArray(persist) && persist.includes('session'));
  return {
    toolName: `${CODEX_CLI_DISPLAY_NAME} MCP 工具调用`,
    toolInput: {
      serverName: params.serverName,
      message: params.message,
      _meta: meta,
    },
    supportsAlways,
    allow: (always) => ({
      action: 'accept',
      content: null,
      _meta: always && supportsAlways ? { persist: 'session' } : null,
    }),
    deny: () => ({ action: 'decline', content: null, _meta: null }),
    cancel: () => ({ action: 'cancel', content: null, _meta: null }),
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
