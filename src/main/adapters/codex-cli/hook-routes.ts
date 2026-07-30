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
import {
  codexDesktopEphemeralFilter,
  type CodexDesktopEphemeralFilterLike,
  type CodexHookIdentity,
} from './desktop-ephemeral-filter';
import {
  openToolUseRepo,
  type OpenToolUseRecord,
} from '@main/store/open-tool-use-repo';
import log from '@main/utils/logger';

const logger = log.scope('codex-hook-routes');

interface BaseBody extends CodexHookIdentity {
  cwd?: string;
  hook_event_name?: string;
}

export interface OpenToolUseReader {
  listForSession(sessionId: string): OpenToolUseRecord[];
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
  openToolUseReader: OpenToolUseReader = openToolUseRepo,
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
  const terminalEvents = (
    body: BaseBody,
    terminalHook: 'Stop' | 'SessionEnd',
    translated: AgentEvent[],
  ): AgentEvent[] => {
    try {
      return [
        ...translateCodexUnclosedToolUses(
          body as never,
          openToolUseReader.listForSession(body.session_id),
          terminalHook,
        ),
        ...translated,
      ];
    } catch (error) {
      // Reconciliation is best-effort. Never lose the authoritative terminal event
      // because the historical lookup is temporarily unavailable.
      logger.warn('[codex-hook-routes] open tool reconciliation failed', {
        sessionId: body.session_id,
        terminalHook,
      }, error);
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
