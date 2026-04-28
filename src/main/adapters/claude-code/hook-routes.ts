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
        // REVIEW_12 Bug 5：读 X-Agent-Deck-Origin header 标记进程归属。
        // SDK spawn 的 CLI 子进程 hook curl 转发为 'sdk'；用户独立终端 `claude` 转发为 'cli'；
        // 老版本 hook 命令（升级前 settings.json 残留）不携带此 header，按 'cli' 兼容。
        const headerVal = request.headers['x-agent-deck-origin'];
        const originRaw = Array.isArray(headerVal) ? headerVal[0] : headerVal;
        const hookOrigin: 'sdk' | 'cli' = originRaw === 'sdk' ? 'sdk' : 'cli';
        const out = handler(body);
        if (Array.isArray(out)) {
          for (const ev of out) emit(ev, hookOrigin);
        } else {
          emit(out, hookOrigin);
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
  // REVIEW_12 Bug 5：再附 hookOrigin 标识进程归属（SDK spawn vs 独立 CLI），
  // ingest 入口据此识别孤儿 SDK-derived hook（OLD CLI fork 后飞回的迟到 event）跳过创建。
  const taggedEmit = (ev: AgentEvent, hookOrigin: 'sdk' | 'cli'): void => {
    emit({ ...ev, source: 'hook', hookOrigin });
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
