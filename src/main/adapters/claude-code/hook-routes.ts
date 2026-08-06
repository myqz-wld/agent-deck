import type { RouteOptions } from 'fastify';
import {
  translateMessageDisplay,
  translateNotification,
  translatePermissionDenied,
  translatePermissionRequest,
  translatePostCompact,
  translatePostToolUse,
  translatePostToolUseFailure,
  translatePreCompact,
  translatePreToolUse,
  translateSessionEnd,
  translateSessionStart,
  translateStop,
  translateStopFailure,
  translateSubagentStart,
  translateSubagentStop,
  translateUserPromptSubmit,
} from './translate';
import type { AgentEvent } from '@shared/types';
import {
  createHookRoute,
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
 * Universal team backend owns team lifecycle state. Provider-specific team events are not
 * registered, and hook traffic never writes team state into that backend.
 */
export function buildHookRoutes(
  emit: (e: AgentEvent) => void,
  diagnostics: HookRouteDiagnostics,
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
    route('MessageDisplay', '/hook/messagedisplay', (b) =>
      translateMessageDisplay(b as never)),
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
    route('PreCompact', '/hook/precompact', (b) => translatePreCompact(b as never)),
    route('PostCompact', '/hook/postcompact', (b) => translatePostCompact(b as never)),
    route('SubagentStart', '/hook/subagentstart', (b) =>
      translateSubagentStart(b as never)),
    route('SubagentStop', '/hook/subagentstop', (b) =>
      translateSubagentStop(b as never)),
    route('Notification', '/hook/notification', (b) => translateNotification(b as never)),
    route('Stop', '/hook/stop', (b) => translateStop(b as never)),
    route('StopFailure', '/hook/stopfailure', (b) => translateStopFailure(b as never)),
    route('SessionEnd', '/hook/sessionend', (b) => translateSessionEnd(b as never)),
  ];
}
