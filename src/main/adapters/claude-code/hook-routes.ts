import type { RouteOptions } from 'fastify';
import {
  translateNotification,
  translatePermissionDenied,
  translatePermissionRequest,
  translatePostCompact,
  translatePostToolUse,
  translatePostToolUseFailure,
  translatePreToolUse,
  translateSessionEnd,
  translateSessionStart,
  translateStop,
  translateStopFailure,
  translateUserPromptSubmit,
} from './translate';
import type { AgentEvent } from '@shared/types';
import {
  createHookRoute,
  hookRouteDiagnostics,
  type HookOrigin,
  type HookRouteDiagnostics,
} from '@main/hook-server/route-diagnostics';

interface BaseBody {
  session_id: string;
  cwd?: string;
}

function makeRoute(
  event: string,
  url: string,
  handler: (body: BaseBody) => AgentEvent | AgentEvent[],
  emit: (e: AgentEvent, hookOrigin: HookOrigin) => void,
  diagnostics: HookRouteDiagnostics,
): RouteOptions {
  return createHookRoute({
    adapter: 'claude-code',
    event,
    url,
    extractSessionId: (body) => {
      if (!body || typeof body !== 'object' || Array.isArray(body)) return null;
      const sessionId = (body as { session_id?: unknown }).session_id;
      return typeof sessionId === 'string' && sessionId.trim()
        ? sessionId.trim()
        : null;
    },
    translate: handler,
    emit,
    diagnostics,
  });
}

/**
 * Universal team backend owns team lifecycle state. Legacy Claude Code experimental team
 * events (task-created / task-completed / teammate-idle) are intentionally not registered,
 * and hook traffic never writes team_name back into that backend.
 */
export function buildHookRoutes(
  emit: (e: AgentEvent) => void,
  diagnostics: HookRouteDiagnostics = hookRouteDiagnostics,
): RouteOptions[] {
  const taggedEmit = (ev: AgentEvent, hookOrigin: HookOrigin): void => {
    emit({ ...ev, source: 'hook', hookOrigin });
  };
  const route = (
    event: string,
    url: string,
    handler: (body: BaseBody) => AgentEvent | AgentEvent[],
  ): RouteOptions => makeRoute(event, url, handler, taggedEmit, diagnostics);
  return [
    route('SessionStart', '/hook/sessionstart', (b) => translateSessionStart(b as never)),
    route(
      'UserPromptSubmit',
      '/hook/userpromptsubmit',
      (b) => translateUserPromptSubmit(b as never),
    ),
    route('PreToolUse', '/hook/pretooluse', (b) => translatePreToolUse(b as never)),
    route(
      'PermissionRequest',
      '/hook/permissionrequest',
      (b) => translatePermissionRequest(b as never),
    ),
    route('PostToolUse', '/hook/posttooluse', (b) => translatePostToolUse(b as never)),
    route(
      'PostToolUseFailure',
      '/hook/posttoolusefailure',
      (b) => translatePostToolUseFailure(b as never),
    ),
    route(
      'PermissionDenied',
      '/hook/permissiondenied',
      (b) => translatePermissionDenied(b as never),
    ),
    route('PostCompact', '/hook/postcompact', (b) => translatePostCompact(b as never)),
    route('Notification', '/hook/notification', (b) => translateNotification(b as never)),
    route('Stop', '/hook/stop', (b) => translateStop(b as never)),
    route('StopFailure', '/hook/stopfailure', (b) => translateStopFailure(b as never)),
    route('SessionEnd', '/hook/sessionend', (b) => translateSessionEnd(b as never)),
  ];
}
