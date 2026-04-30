import type { RouteOptions } from 'fastify';
import {
  translateNotification,
  translatePostToolUse,
  translatePreToolUse,
  translateSessionEnd,
  translateSessionStart,
  translateStop,
  translateTaskCompleted,
  translateTaskCreated,
  translateTeammateIdle,
} from './translate';
import type { AgentEvent } from '@shared/types';
import { extractTeamNameFromToolInput, teamCoordinator } from '@main/teams/team-coordinator';

interface BaseBody {
  session_id: string;
  cwd?: string;
}

/**
 * 抽 PreToolUse / TeamHook payload 中的 team_name 反向同步到 sessions.team_name DB 列。
 * CHANGELOG_46：取代之前 NewSessionDialog 预填 + IPC 入口预写的方案。
 *
 * 收口走 [team-coordinator.ts](../../teams/team-coordinator.ts) 的 `sync()` 函数（幂等）。
 *
 * 三种来源：
 * - PreToolUse(`TeamCreate / TeamDelete / Teammate / SendMessage`) → tool_input 取 team 名
 * - TeammateIdle / TaskCreated / TaskCompleted → payload.team_name
 * - fs add `~/.claude/teams/<X>/config.json` → 由 team-coordinator 自身 chokidar watcher 触发
 */
function maybeSyncFromPreToolUse(body: BaseBody): void {
  const p = body as BaseBody & { tool_name?: unknown; tool_input?: unknown };
  if (typeof p.tool_name !== 'string') return;
  const teamName = extractTeamNameFromToolInput(p.tool_name, p.tool_input);
  if (!teamName) return;
  teamCoordinator.sync(body.session_id, teamName, 'pretool');
}

function maybeSyncFromTeamHook(body: BaseBody): void {
  const p = body as BaseBody & { team_name?: unknown };
  if (typeof p.team_name !== 'string' || p.team_name.length === 0) return;
  teamCoordinator.sync(body.session_id, p.team_name, 'hook');
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
    makeRoute(
      '/hook/pretooluse',
      (b) => {
        // CHANGELOG_46：PreToolUse 拦截 team 工具反向同步 team_name 到 DB（最早通道）
        maybeSyncFromPreToolUse(b);
        return translatePreToolUse(b as never);
      },
      taggedEmit,
    ),
    makeRoute('/hook/posttooluse', (b) => translatePostToolUse(b as never), taggedEmit),
    makeRoute('/hook/notification', (b) => translateNotification(b as never), taggedEmit),
    makeRoute('/hook/stop', (b) => translateStop(b as never), taggedEmit),
    makeRoute('/hook/sessionend', (b) => translateSessionEnd(b as never), taggedEmit),
    // M3 Agent Teams hook（Claude Code v2.1.32+ 实验特性）。
    // 老版本 CLI 没有这些 hook event，路由存在但收不到 hit；schema 演进由 translate 函数宽容兜底。
    // CHANGELOG_46：三个 team hook 都加 maybeSyncFromTeamHook 反向同步（PreToolUse 兜底）
    makeRoute(
      '/hook/taskcreated',
      (b) => {
        maybeSyncFromTeamHook(b);
        return translateTaskCreated(b as never);
      },
      taggedEmit,
    ),
    makeRoute(
      '/hook/taskcompleted',
      (b) => {
        maybeSyncFromTeamHook(b);
        return translateTaskCompleted(b as never);
      },
      taggedEmit,
    ),
    makeRoute(
      '/hook/teammateidle',
      (b) => {
        maybeSyncFromTeamHook(b);
        return translateTeammateIdle(b as never);
      },
      taggedEmit,
    ),
  ];
}
