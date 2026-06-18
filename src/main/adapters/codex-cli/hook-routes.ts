import type { RouteOptions } from 'fastify';
import type { AgentEvent } from '@shared/types';
import {
  translateCodexPermissionRequest,
  translateCodexPostCompact,
  translateCodexPostToolUse,
  translateCodexPreToolUse,
  translateCodexSessionStart,
  translateCodexStop,
} from './hook-translate';

interface BaseBody {
  session_id: string;
  cwd?: string;
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

export function buildCodexHookRoutes(emit: (e: AgentEvent) => void): RouteOptions[] {
  const taggedEmit = (ev: AgentEvent, hookOrigin: 'sdk' | 'cli'): void => {
    emit({ ...ev, source: 'hook', hookOrigin });
  };
  return [
    makeRoute('/hook/codex/sessionstart', (b) => translateCodexSessionStart(b as never), taggedEmit),
    makeRoute('/hook/codex/pretooluse', (b) => translateCodexPreToolUse(b as never), taggedEmit),
    makeRoute(
      '/hook/codex/permissionrequest',
      (b) => translateCodexPermissionRequest(b as never),
      taggedEmit,
    ),
    makeRoute('/hook/codex/posttooluse', (b) => translateCodexPostToolUse(b as never), taggedEmit),
    makeRoute('/hook/codex/postcompact', (b) => translateCodexPostCompact(b as never), taggedEmit),
    makeRoute('/hook/codex/stop', (b) => translateCodexStop(b as never), taggedEmit),
  ];
}
