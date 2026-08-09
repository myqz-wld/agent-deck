import type { RouteOptions } from 'fastify';
import type { AgentEvent } from '@shared/types';
import {
  createHookRoute,
  type HookOrigin,
  type HookRouteDiagnostics,
} from '@main/hook-server/route-diagnostics';
import {
  translateCodexPermissionRequest,
  translateCodexPostCompact,
  translateCodexPostToolUse,
  translateCodexPreCompact,
  translateCodexPreToolUse,
  translateCodexSessionEnd,
  translateCodexSessionStart,
  translateCodexStop,
  translateCodexSubagentStart,
  translateCodexSubagentStop,
  translateCodexUnclosedToolUses,
  translateCodexUserPrompt,
} from './hook-translate';
import type {
  CodexHookFilterPort,
  CodexHookIdentity,
  CodexHookRoutePorts,
} from './hook-route-ports';

interface BaseBody extends CodexHookIdentity {
  cwd?: string;
  hook_event_name?: string;
}

function makeRoute(
  event: string,
  url: string,
  handler: (body: BaseBody) => AgentEvent | AgentEvent[],
  emit: (e: AgentEvent, hookOrigin: HookOrigin) => void,
  desktopEphemeralFilter: CodexHookFilterPort,
  diagnostics: HookRouteDiagnostics,
): RouteOptions {
  return createHookRoute({
    adapter: 'codex-cli',
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
    preprocessFailureMode: 'continue',
    preprocess: async ({ body, origin, externalProcessPid }) => {
      try {
        return await desktopEphemeralFilter.shouldIgnore(
          body,
          origin,
          externalProcessPid,
        );
      } catch {
        // Process identity is an optional noise filter. Lookup failure must preserve hooks.
        return false;
      }
    },
  });
}

export function buildCodexHookRoutes(
  emit: (e: AgentEvent) => void,
  ports: CodexHookRoutePorts,
): RouteOptions[] {
  const taggedEmit = (ev: AgentEvent, hookOrigin: HookOrigin): void => {
    emit({ ...ev, source: 'hook', hookOrigin });
  };
  const route = (
    event: string,
    url: string,
    handler: (body: BaseBody) => AgentEvent | AgentEvent[],
  ): RouteOptions =>
    makeRoute(
      event,
      url,
      handler,
      taggedEmit,
      ports.filter,
      ports.diagnostics,
    );
  const terminalEvents = (
    body: BaseBody,
    terminalHook: 'Stop' | 'SessionEnd',
    translated: AgentEvent[],
  ): AgentEvent[] => {
    try {
      return [
        ...translateCodexUnclosedToolUses(
          body as never,
          ports.openToolUseReader.listForSession(body.session_id),
          terminalHook,
        ),
        ...translated,
      ];
    } catch (error) {
      // Reconciliation is best-effort. Never lose the authoritative terminal event
      // because the historical lookup is temporarily unavailable.
      try {
        ports.observer.reconciliationFailed({
          sessionId: body.session_id,
          terminalHook,
          error,
        });
      } catch {
        // Observation cannot replace the authoritative terminal event.
      }
      return translated;
    }
  };
  return [
    route('SessionStart', '/hook/codex/sessionstart', (b) =>
      translateCodexSessionStart(b as never)),
    route('UserPromptSubmit', '/hook/codex/userpromptsubmit', (b) =>
      translateCodexUserPrompt(b as never)),
    route('PreToolUse', '/hook/codex/pretooluse', (b) =>
      translateCodexPreToolUse(b as never)),
    route(
      'PermissionRequest',
      '/hook/codex/permissionrequest',
      (b) => translateCodexPermissionRequest(b as never),
    ),
    route('PostToolUse', '/hook/codex/posttooluse', (b) =>
      translateCodexPostToolUse(b as never)),
    route('PreCompact', '/hook/codex/precompact', (b) =>
      translateCodexPreCompact(b as never)),
    route('PostCompact', '/hook/codex/postcompact', (b) =>
      translateCodexPostCompact(b as never)),
    route('SubagentStart', '/hook/codex/subagentstart', (b) =>
      translateCodexSubagentStart(b as never)),
    route('SubagentStop', '/hook/codex/subagentstop', (b) =>
      translateCodexSubagentStop(b as never)),
    route('Stop', '/hook/codex/stop', (b) =>
      terminalEvents(b, 'Stop', translateCodexStop(b as never))),
    route('SessionEnd', '/hook/codex/sessionend', (b) =>
      terminalEvents(b, 'SessionEnd', [translateCodexSessionEnd(b as never)])),
  ];
}
