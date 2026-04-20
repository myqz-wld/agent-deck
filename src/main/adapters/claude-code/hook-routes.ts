import type { RouteOptions } from 'fastify';
import {
  translateNotification,
  translatePostToolUse,
  translatePreToolUse,
  translateSessionEnd,
  translateSessionStart,
  translateStop,
} from './translate';
import type { AgentEvent } from '@shared/types';

interface BaseBody {
  session_id: string;
  cwd?: string;
}

function makeRoute(
  url: string,
  handler: (body: BaseBody) => AgentEvent | AgentEvent[],
  emit: (e: AgentEvent) => void,
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
        const out = handler(body);
        if (Array.isArray(out)) {
          for (const ev of out) emit(ev);
        } else {
          emit(out);
        }
        reply.code(200).send({ ok: true });
      } catch (err) {
        reply.code(500).send({ ok: false, error: (err as Error).message });
      }
    },
  };
}

export function buildHookRoutes(emit: (e: AgentEvent) => void): RouteOptions[] {
  // 所有从 hook 通道发来的事件统一打上 source: 'hook'，
  // 让 SessionManager 能据此对 SDK 通道已接管的会话做去重。
  const taggedEmit = (ev: AgentEvent): void => {
    emit({ ...ev, source: 'hook' });
  };
  return [
    makeRoute('/hook/sessionstart', (b) => translateSessionStart(b as never), taggedEmit),
    makeRoute('/hook/pretooluse', (b) => translatePreToolUse(b as never), taggedEmit),
    makeRoute('/hook/posttooluse', (b) => translatePostToolUse(b as never), taggedEmit),
    makeRoute('/hook/notification', (b) => translateNotification(b as never), taggedEmit),
    makeRoute('/hook/stop', (b) => translateStop(b as never), taggedEmit),
    makeRoute('/hook/sessionend', (b) => translateSessionEnd(b as never), taggedEmit),
  ];
}
