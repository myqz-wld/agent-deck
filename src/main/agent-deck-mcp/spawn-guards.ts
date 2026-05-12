/**
 * Agent Deck MCP `spawn_session` 防递归 3 条规则（B'0 ADR §6.1 / §6.3 / §6.4 + §6.6 Race Protection）。
 *
 * 抽到独立模块让 tools.ts 不爆 500 行 + 单测可单独覆盖 3 条规则的全部边界。
 *
 * 3 条规则按代价从低到高 + 「不消耗资源的检查前置」顺序执行（REVIEW_28 reviewer-codex MED-1）：
 * 1. depth 上限（O(1) DB 单查 spawn_depth；不消耗资源）
 * 2. fan-out（O(parent_children) DB 反查 + 同步段 in-flight 计数叠加；不消耗 rate token）
 * 3. spawn-rate 滑动窗口（O(1) 同步段 tryConsume；**消耗 token**，所以放最后）
 *
 * 任一 deny 立即返回，不继续后续规则（节省 work）。
 *
 * **顺序设计要点**（REVIEW_28 reviewer-codex MED-1）：rate token 被 fan-out deny 消耗会
 * 导致一个已达 fan-out=5 的 lead spam spawn_session 时把 app-wide token 拒掉给别的合法
 * lead 用 → 饥饿。改为「rate token 在 depth + fan-out 都通过后才扣」，避免这条饥饿路径。
 *
 * **Race protection**（REVIEW_27 reviewer 双对抗 MED 修法）：fan-out check + inFlightChildren.inc
 * 必须在同一同步段内完成，handler 后续 await createSession；createSession 失败 / 完成时
 * 必须保证 dec 一次（finally 兜底）。
 *
 * **2026-05 移除 §6.2 cwd realpath 整链回溯**（REVIEW_28）：原 §6.2 同 cwd 同 adapter 拒绝
 * 拦掉了 deep-code-review SKILL 的合法用例（lead 在 repo 起两 reviewer teammate 同 cwd 同
 * adapter）。残留语义自递归（lead 同 cwd 同 adapter 反复 spawn）由 §6.1 depth=3 截断接受
 * （fan-out=1 时最多 3 层 spawn 即停），不再阻断；详 ADR §6.2 与 reviews/REVIEW_28.md。
 */

import type { CallerContext } from './types';
import { sessionRepo } from '@main/store/session-repo';
import { settingsStore } from '@main/store/settings-store';
import { spawnRateLimiter, inFlightChildren } from './rate-limiter';

export interface GuardDenial {
  content: { type: 'text'; text: string }[];
  isError: true;
}

function deny(error: string, hint?: string): GuardDenial {
  return {
    content: [
      {
        type: 'text' as const,
        text: JSON.stringify(hint ? { error, hint } : { error }),
      },
    ],
    isError: true as const,
  };
}

/**
 * 应用 3 条防递归规则。**必须**在 spawn_session handler 调 createSession 前同步段内调用。
 *
 * 返回值：
 * - GuardDenial：拒绝，handler 直接返回该值（带 isError:true）
 * - { ok: true, parentDepth, fanOutSlot }：通过，handler 继续；fanOutSlot 必须在
 *   handler 末尾（无论 createSession 成功 / 失败）调 .release() 释放 in-flight 计数
 */
export function applySpawnGuards(
  caller: CallerContext,
  _newCwd: string,
  _newAdapter: string,
): GuardDenial | { ok: true; parentDepth: number; fanOutSlot: { release: () => void } } {
  const settings = settingsStore.getAll();
  const maxDepth = settings.mcpMaxSpawnDepth ?? 3;
  const maxFanOut = settings.mcpMaxFanOutPerParent ?? 5;
  const ratePerMin = settings.mcpSpawnRatePerMinute ?? 10;

  // 0. 同步刷新 RateLimiter 配置（hot-toggle 用户 Settings 立即生效）
  spawnRateLimiter.setLimits(ratePerMin, 60_000);

  // 1. depth 上限（不消耗资源，最先）
  const parentDepth = sessionRepo.getSpawnDepth(caller.callerSessionId);
  if (parentDepth >= maxDepth) {
    return deny(
      `spawn depth ${parentDepth} >= max ${maxDepth}`,
      `Increase Settings → MCP Server → mcpMaxSpawnDepth (current: ${maxDepth}) if you really need a deeper chain. Default 3 covers lead → teammate → sub-teammate.`,
    );
  }

  // 2. fan-out（同步段内 check + inc 防穿透；不消耗 rate token）
  const dbChildren = sessionRepo.listChildren(caller.callerSessionId, 'active').length;
  const inFlight = inFlightChildren.get(caller.callerSessionId);
  const effective = dbChildren + inFlight;
  if (effective + 1 > maxFanOut) {
    return deny(
      `fan-out ${effective} reached for parent ${caller.callerSessionId} (max ${maxFanOut})`,
      'Wait for in-flight children to settle, or shutdown some before spawning more. Increase Settings → MCP Server → mcpMaxFanOutPerParent if you genuinely need more.',
    );
  }

  // 3. spawn-rate 滑动窗口（**消耗 token**，必须最后；fan-out 通过才扣）
  if (!spawnRateLimiter.tryConsume()) {
    const retry = spawnRateLimiter.retryAfterMs();
    return deny(
      `app-wide spawn rate exceeded: ${ratePerMin}/min (retry after ${Math.ceil(retry)}ms)`,
      `Wait ~${Math.ceil(retry / 1000)}s before retrying. Increase Settings → MCP Server → mcpSpawnRatePerMinute if you frequently run parallel deep-review.`,
    );
  }

  // 三条全过 → 占 in-flight slot；handler 末尾 release
  inFlightChildren.inc(caller.callerSessionId);
  let released = false;
  return {
    ok: true,
    parentDepth,
    fanOutSlot: {
      release: () => {
        if (released) return;
        released = true;
        inFlightChildren.dec(caller.callerSessionId);
      },
    },
  };
}
