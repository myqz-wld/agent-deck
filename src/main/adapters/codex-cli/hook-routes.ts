import type { RouteOptions } from 'fastify';
import type { AgentEvent } from '@shared/types';
import {
  createHookRoute,
  hookRouteDiagnostics,
  type HookOrigin,
  type HookRouteDiagnostics,
} from '@main/hook-server/route-diagnostics';
import {
  translateCodexPermissionRequest,
  translateCodexPostCompact,
  translateCodexPostToolUse,
  translateCodexPreToolUse,
  translateCodexSessionEnd,
  translateCodexSessionStart,
  translateCodexStop,
  translateCodexUserPrompt,
} from './hook-translate';
import {
  codexDesktopEphemeralFilter,
  type CodexDesktopEphemeralFilterLike,
  type CodexHookIdentity,
} from './desktop-ephemeral-filter';

interface BaseBody extends CodexHookIdentity {
  cwd?: string;
  hook_event_name?: string;
}

function makeRoute(
  event: string,
  url: string,
  handler: (body: BaseBody) => AgentEvent | AgentEvent[],
  emit: (e: AgentEvent, hookOrigin: HookOrigin) => void,
  desktopEphemeralFilter: CodexDesktopEphemeralFilterLike,
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
  desktopEphemeralFilter: CodexDesktopEphemeralFilterLike = codexDesktopEphemeralFilter,
  diagnostics: HookRouteDiagnostics = hookRouteDiagnostics,
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
      desktopEphemeralFilter,
      diagnostics,
    );
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
    route('PostCompact', '/hook/codex/postcompact', (b) =>
      translateCodexPostCompact(b as never)),
    route('Stop', '/hook/codex/stop', (b) => translateCodexStop(b as never)),
    route('SessionEnd', '/hook/codex/sessionend', (b) =>
      translateCodexSessionEnd(b as never)),
  ];
}
