/**
 * Agent Deck MCP `spawn_session` 防递归 4 条规则（B'0 ADR §6.1-§6.4 + §6.6 Race Protection）。
 *
 * 抽到独立模块让 tools.ts 不爆 500 行 + 单测可单独覆盖 4 条规则的全部边界。
 *
 * 4 条规则按代价从低到高顺序执行（先廉价同步、再 DB 反查、最后整链回溯）：
 * 1. depth 上限（O(1) DB 单查 spawn_depth）
 * 2. spawn-rate 滑动窗口（O(1) 同步段，最早过期裁剪）
 * 3. fan-out（O(parent_children) DB 反查 + 同步段 in-flight 计数叠加）
 * 4. 整链回溯 cwd realpath cycle（O(depth) DB 反查 + realpath 系统调用）
 *
 * 任一 deny 立即返回，不继续后续规则（节省 work）。
 *
 * **Race protection**（reviewer 双对抗 MED 修法）：fan-out check + inFlightChildren.inc
 * 必须在同一同步段内完成，handler 后续 await createSession；createSession 失败 / 完成时
 * 必须保证 dec 一次（finally 兜底）。
 */

import { realpathSync } from 'node:fs';
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

function safeRealpath(p: string): string {
  try {
    return realpathSync(p);
  } catch {
    return p;
  }
}

/**
 * 沿 spawn_chain 整链回溯 cwd realpath + adapter cycle 检测（§6.2）。
 *
 * 即将 spawn 的 (cwd_real, adapter) 与 caller + 所有祖先的 (cwd_real, agentId) 比较；
 * 任一同 cwd 同 adapter ⇒ deny。
 *
 * 链长 ≤ MAX_DEPTH（默认 3），反查 cost O(depth)。caller 不在 sessionRepo（in-process
 * 闭包伪 id 兼容）⇒ 只比 caller 自身（newAdapter ≠ unknown caller adapter，跳过）。
 */
function checkCwdCycleAlongChain(
  caller: CallerContext,
  newCwd: string,
  newAdapter: string,
): GuardDenial | null {
  const callerSession = sessionRepo.get(caller.callerSessionId);
  if (!callerSession) return null;
  const newReal = safeRealpath(newCwd);
  // 比较 caller 自身
  if (callerSession.agentId === newAdapter) {
    const callerReal = safeRealpath(callerSession.cwd);
    if (callerReal === newReal) {
      return deny(
        `same-cwd same-adapter spawn cycle detected: caller @ ${callerReal}, new @ ${newReal}`,
        'Spawning a session in the same cwd with the same adapter as your own would create a tight loop. Use a different cwd or a different adapter.',
      );
    }
  }
  // 沿祖先链回溯
  const ancestors = sessionRepo.listAncestors(caller.callerSessionId);
  for (const a of ancestors) {
    if (a.agentId !== newAdapter) continue;
    const aReal = safeRealpath(a.cwd);
    if (aReal === newReal) {
      return deny(
        `ancestor cwd cycle detected at depth ${a.spawnDepth ?? 0}: ancestor ${a.id} @ ${aReal}, new @ ${newReal}, adapter=${newAdapter}`,
        'Spawning would create a cycle: an ancestor session in your spawn chain already runs the same adapter in the same cwd. Use a different cwd or adapter.',
      );
    }
  }
  return null;
}

/**
 * 应用 4 条防递归规则。**必须**在 spawn_session handler 调 createSession 前同步段内调用。
 *
 * 返回值：
 * - GuardDenial：拒绝，handler 直接返回该值（带 isError:true）
 * - { ok: true, parentDepth, fanOutSlot }：通过，handler 继续；fanOutSlot 必须在
 *   handler 末尾（无论 createSession 成功 / 失败）调 .release() 释放 in-flight 计数
 */
export function applySpawnGuards(
  caller: CallerContext,
  newCwd: string,
  newAdapter: string,
): GuardDenial | { ok: true; parentDepth: number; fanOutSlot: { release: () => void } } {
  const settings = settingsStore.getAll();
  const maxDepth = settings.mcpMaxSpawnDepth ?? 3;
  const maxFanOut = settings.mcpMaxFanOutPerParent ?? 5;
  const ratePerMin = settings.mcpSpawnRatePerMinute ?? 10;

  // 0. 同步刷新 RateLimiter 配置（hot-toggle 用户 Settings 立即生效）
  spawnRateLimiter.setLimits(ratePerMin, 60_000);

  // 1. depth 上限
  const parentDepth = sessionRepo.getSpawnDepth(caller.callerSessionId);
  if (parentDepth >= maxDepth) {
    return deny(
      `spawn depth ${parentDepth} >= max ${maxDepth}`,
      `Increase Settings → MCP Server → mcpMaxSpawnDepth (current: ${maxDepth}) if you really need a deeper chain. Default 3 covers lead → teammate → sub-teammate.`,
    );
  }

  // 2. spawn-rate 滑动窗口
  if (!spawnRateLimiter.tryConsume()) {
    const retry = spawnRateLimiter.retryAfterMs();
    return deny(
      `app-wide spawn rate exceeded: ${ratePerMin}/min (retry after ${Math.ceil(retry)}ms)`,
      `Wait ~${Math.ceil(retry / 1000)}s before retrying. Increase Settings → MCP Server → mcpSpawnRatePerMinute if you frequently run parallel deep-review.`,
    );
  }

  // 3. fan-out（同步段内 inc + check 防穿透）
  const dbChildren = sessionRepo.listChildren(caller.callerSessionId, 'active').length;
  const inFlight = inFlightChildren.get(caller.callerSessionId);
  const effective = dbChildren + inFlight;
  if (effective + 1 > maxFanOut) {
    return deny(
      `fan-out ${effective} reached for parent ${caller.callerSessionId} (max ${maxFanOut})`,
      'Wait for in-flight children to settle, or shutdown some before spawning more. Increase Settings → MCP Server → mcpMaxFanOutPerParent if you genuinely need more.',
    );
  }
  inFlightChildren.inc(caller.callerSessionId); // 同步占位（race protection）

  // 4. cwd realpath 整链回溯（最贵，放最后）
  const cycleErr = checkCwdCycleAlongChain(caller, newCwd, newAdapter);
  if (cycleErr) {
    inFlightChildren.dec(caller.callerSessionId); // 已 inc 的 slot 必须 dec
    return cycleErr;
  }

  // 通过：返回 fanOutSlot 让 handler 在 createSession 完成后 release
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
