import type { RouteOptions } from 'fastify';
import {
  translateNotification,
  translatePostCompact,
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

/**
 * R3.E6：删除 3 个 team hook route + maybeSyncFromPreToolUse / maybeSyncFromTeamHook。
 * 老 Claude Code experimental teams hook 协议（task-created / task-completed / teammate-idle）
 * 不再监听；team 关系由 universal team backend (DB) 主导，hook 通道不再反向同步 team_name。
 */
export function buildHookRoutes(emit: (e: AgentEvent) => void): RouteOptions[] {
  const taggedEmit = (ev: AgentEvent, hookOrigin: 'sdk' | 'cli'): void => {
    emit({ ...ev, source: 'hook', hookOrigin });
  };
  return [
    makeRoute('/hook/sessionstart', (b) => translateSessionStart(b as never), taggedEmit),
    makeRoute('/hook/pretooluse', (b) => translatePreToolUse(b as never), taggedEmit),
    makeRoute('/hook/posttooluse', (b) => translatePostToolUse(b as never), taggedEmit),
    makeRoute('/hook/postcompact', (b) => translatePostCompact(b as never), taggedEmit),
    makeRoute('/hook/notification', (b) => translateNotification(b as never), taggedEmit),
    makeRoute('/hook/stop', (b) => translateStop(b as never), taggedEmit),
    makeRoute('/hook/sessionend', (b) => translateSessionEnd(b as never), taggedEmit),
  ];
}
