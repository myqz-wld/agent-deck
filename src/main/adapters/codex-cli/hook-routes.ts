import type { RouteOptions } from 'fastify';
import type { AgentEvent } from '@shared/types';
import log from '@main/utils/logger';
import {
  translateCodexPermissionRequest,
  translateCodexPostCompact,
  translateCodexPostToolUse,
  translateCodexPreToolUse,
  translateCodexSessionStart,
  translateCodexStop,
} from './hook-translate';
import {
  codexDesktopEphemeralFilter,
  type CodexDesktopEphemeralFilterLike,
  type CodexHookIdentity,
} from './desktop-ephemeral-filter';

const logger = log.scope('codex-hook-routes');

interface BaseBody extends CodexHookIdentity {
  cwd?: string;
  hook_event_name?: string;
}

function firstHeaderValue(value: string | string[] | undefined): string {
  return Array.isArray(value) ? (value[0] ?? '') : (value ?? '');
}

function parsePidHeader(value: string | string[] | undefined): number | null {
  const raw = firstHeaderValue(value).trim();
  if (!/^\d+$/.test(raw)) return null;
  const pid = Number(raw);
  return Number.isSafeInteger(pid) && pid > 0 ? pid : null;
}

function attachExternalProcessPid(ev: AgentEvent, pid: number | null): AgentEvent {
  if (pid === null) return ev;
  const payload =
    ev.payload && typeof ev.payload === 'object' && !Array.isArray(ev.payload)
      ? { ...(ev.payload as Record<string, unknown>), externalProcessPid: pid }
      : { value: ev.payload, externalProcessPid: pid };
  return { ...ev, payload };
}

function makeRoute(
  url: string,
  handler: (body: BaseBody) => AgentEvent | AgentEvent[],
  emit: (e: AgentEvent, hookOrigin: 'sdk' | 'cli') => void,
  desktopEphemeralFilter: CodexDesktopEphemeralFilterLike,
): RouteOptions {
  return {
    method: 'POST',
    url,
    handler: async (request, reply) => {
      try {
        const body = (request.body ?? {}) as BaseBody;
        if (!body || !body.session_id) {
          reply.code(400).send({ ok: false, error: 'missing session_id' });
          return;
        }
        const originRaw = firstHeaderValue(request.headers['x-agent-deck-origin']);
        const hookOrigin: 'sdk' | 'cli' = originRaw === 'sdk' ? 'sdk' : 'cli';
        const externalProcessPid = parsePidHeader(request.headers['x-agent-deck-parent-pid']);
        let ignoreDesktopEphemeral = false;
        try {
          ignoreDesktopEphemeral = await desktopEphemeralFilter.shouldIgnore(
            body,
            hookOrigin,
            externalProcessPid,
          );
        } catch {
          // Process identity is an optional noise filter. Any lookup failure must preserve hooks.
        }
        if (ignoreDesktopEphemeral) {
          if (body.hook_event_name === 'SessionStart') {
            logger.info(
              `[codex-hook] ignored Desktop ephemeral session sid=${body.session_id} pid=${externalProcessPid}`,
            );
          }
          reply.code(200).send({ ok: true, ignored: true });
          return;
        }
        const out = handler(body);
        if (Array.isArray(out)) {
          for (const ev of out) emit(attachExternalProcessPid(ev, externalProcessPid), hookOrigin);
        } else {
          emit(attachExternalProcessPid(out, externalProcessPid), hookOrigin);
        }
        reply.code(200).send({ ok: true });
      } catch (err) {
        reply.code(500).send({ ok: false, error: (err as Error).message });
      }
    },
  };
}

export function buildCodexHookRoutes(
  emit: (e: AgentEvent) => void,
  desktopEphemeralFilter: CodexDesktopEphemeralFilterLike = codexDesktopEphemeralFilter,
): RouteOptions[] {
  const taggedEmit = (ev: AgentEvent, hookOrigin: 'sdk' | 'cli'): void => {
    emit({ ...ev, source: 'hook', hookOrigin });
  };
  const route = (
    url: string,
    handler: (body: BaseBody) => AgentEvent | AgentEvent[],
  ): RouteOptions => makeRoute(url, handler, taggedEmit, desktopEphemeralFilter);
  return [
    route('/hook/codex/sessionstart', (b) => translateCodexSessionStart(b as never)),
    route('/hook/codex/pretooluse', (b) => translateCodexPreToolUse(b as never)),
    route(
      '/hook/codex/permissionrequest',
      (b) => translateCodexPermissionRequest(b as never),
    ),
    route('/hook/codex/posttooluse', (b) => translateCodexPostToolUse(b as never)),
    route('/hook/codex/postcompact', (b) => translateCodexPostCompact(b as never)),
    route('/hook/codex/stop', (b) => translateCodexStop(b as never)),
  ];
}
