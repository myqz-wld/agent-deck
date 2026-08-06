import type { RouteOptions } from 'fastify';
import type { AgentEvent } from '@shared/types';
import {
  createHookRoute,
  type HookOrigin,
  type HookRouteDiagnostics,
} from '@main/hook-server/route-diagnostics';
import {
  type BaseGrokHookPayload,
  translateGrokNotification,
  translateGrokPermissionDenied,
  translateGrokPostCompact,
  translateGrokPostToolUse,
  translateGrokPostToolUseFailure,
  translateGrokPreCompact,
  translateGrokPreToolUse,
  translateGrokSessionEnd,
  translateGrokSessionStart,
  translateGrokStop,
  translateGrokStopFailure,
  translateGrokSubagentStart,
  translateGrokSubagentStop,
  translateGrokUserPrompt,
} from './hook-translate';

type HookTranslator = (
  body: BaseGrokHookPayload & Record<string, unknown>,
) => AgentEvent | AgentEvent[];

function makeRoute(
  event: string,
  url: string,
  translate: HookTranslator,
  emit: (event: AgentEvent, origin: HookOrigin) => void,
  diagnostics: HookRouteDiagnostics,
): RouteOptions {
  return createHookRoute({
    adapter: 'grok-build',
    event,
    url,
    extractSessionId: (body) => {
      if (!body || typeof body !== 'object' || Array.isArray(body)) return null;
      const sessionId = (body as { sessionId?: unknown }).sessionId;
      return typeof sessionId === 'string' && sessionId.trim()
        ? sessionId.trim()
        : null;
    },
    translate,
    emit,
    diagnostics,
  });
}

export function buildGrokHookRoutes(
  emit: (event: AgentEvent) => void,
  diagnostics: HookRouteDiagnostics,
): RouteOptions[] {
  const taggedEmit = (event: AgentEvent, origin: HookOrigin): void => {
    emit({ ...event, source: 'hook', hookOrigin: origin });
  };
  const route = (
    event: string,
    path: string,
    translate: HookTranslator,
  ): RouteOptions =>
    makeRoute(event, `/hook/grok/${path}`, translate, taggedEmit, diagnostics);

  return [
    route('SessionStart', 'sessionstart', translateGrokSessionStart),
    route('UserPromptSubmit', 'userpromptsubmit', translateGrokUserPrompt),
    route('PreToolUse', 'pretooluse', translateGrokPreToolUse),
    route('PostToolUse', 'posttooluse', translateGrokPostToolUse),
    route('PostToolUseFailure', 'posttoolusefailure', translateGrokPostToolUseFailure),
    route('PermissionDenied', 'permissiondenied', translateGrokPermissionDenied),
    route('PreCompact', 'precompact', translateGrokPreCompact),
    route('PostCompact', 'postcompact', translateGrokPostCompact),
    route('SubagentStart', 'subagentstart', translateGrokSubagentStart),
    route('SubagentStop', 'subagentstop', translateGrokSubagentStop),
    route('Notification', 'notification', translateGrokNotification),
    route('Stop', 'stop', translateGrokStop),
    route('StopFailure', 'stopfailure', translateGrokStopFailure),
    route('SessionEnd', 'sessionend', translateGrokSessionEnd),
  ];
}
