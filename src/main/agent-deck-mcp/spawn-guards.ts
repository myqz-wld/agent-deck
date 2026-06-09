/**
 * Agent Deck MCP `spawn_session` 防递归 3 条规则（B'0 ADR §6.1 / §6.3 / §6.4 + §6.6 Race Protection）。
 *
 * 抽到独立模块让 tools.ts 不爆 500 行 + 单测可单独覆盖 3 条规则的全部边界。
 *
 * 3 条规则按代价从低到高 + 「不消耗资源的检查前置」顺序执行（REVIEW_28 reviewer-codex MED-1）：
 * 1. depth 上限（spawn_depth 单查；不消耗 rate token）
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
 * （fan-out=1 时最多 3 层 spawn 即停），不再阻断；详 ADR §6.2 与 ref/reviews/REVIEW_28.md。
 */

import type { CallerContext } from './types';
import type { SpawnSessionLimits } from './tools/schemas';
import { sessionRepo } from '@main/store/session-repo';
import { settingsStore } from '@main/store/settings-store';
import { spawnRateLimiter, inFlightChildren } from './rate-limiter';

export interface GuardDenial {
  content: { type: 'text'; text: string }[];
  isError: true;
}

const SPAWN_RATE_WINDOW_MS = 60_000;

function buildSpawnLimits(input: {
  parentDepth: number;
  nextDepth: number;
  activeChildren: number;
  inFlight: number;
  maxDepth: number;
  maxFanOut: number;
  rateCurrent: number;
  rateMax: number;
  retryAfterMs?: number;
}): SpawnSessionLimits {
  return {
    depth: {
      current: input.parentDepth,
      next: input.nextDepth,
      max: input.maxDepth,
    },
    fanOut: {
      current: input.activeChildren + input.inFlight,
      activeChildren: input.activeChildren,
      inFlight: input.inFlight,
      max: input.maxFanOut,
    },
    rate: {
      current: input.rateCurrent,
      max: input.rateMax,
      windowMs: SPAWN_RATE_WINDOW_MS,
      retryAfterMs: input.retryAfterMs ?? 0,
    },
  };
}

function deny(error: string, hint: string | undefined, spawnLimits: SpawnSessionLimits): GuardDenial {
  return {
    content: [
      {
        type: 'text' as const,
        text: JSON.stringify(hint ? { error, hint, spawnLimits } : { error, spawnLimits }),
      },
    ],
    isError: true as const,
  };
}

/**
 * 应用 3 条防递归规则。**必须**在 spawn_session handler 调 createSession 前同步段内调用。
 *
 * **plan handoff-no-spawn-guards-20260526 §D4 / §D6 (handOffMode 升级 batonMode)**：
 * `opts.handOffMode = true` 时**三道全跳**(depth + fan-out + spawn-rate)+ **不进 in-flight
 * 计数表**(inFlightChildren.inc 也跳)。hand-off 是平级接力(用户原话「都是平级的」+
 * 「不进行任何和 spawn session 有关的检查」),`archiveCaller=false × N` 滥用风险由
 * power-user 自负责任(详 §D3 + §D4)。故意推翻 REVIEW_46/47 当年的「archiveCaller=false
 * 退化 normal spawn」修法。
 *
 * **historical 名词**: `handOffMode` 历史上叫 `batonMode`(CHANGELOG_98 / REVIEW_39/46/47/48);
 * 改名同款语义升级(原仅跳 depth → 现跳三道 + 不进 in-flight 计数表)。
 *
 * 参数：
 * - caller: 调用上下文（含 callerSessionId）
 * - _newCwd / _newAdapter: 兼容老签名，目前内部无引用（§6.2 移除后）
 * - opts.handOffMode: 是否走 hand-off 路径(完全独立于 spawn-guards;默认 false = 普通 spawn)
 *
 * 返回值：
 * - GuardDenial：拒绝，handler 直接返回该值（带 isError:true）
 * - { ok: true, parentDepth, fanOutSlot }：通过，handler 继续；fanOutSlot 必须在
 *   handler 末尾（无论 createSession 成功 / 失败）调 .release() 释放 in-flight 计数
 *   (handOffMode=true 路径 release 是 no-op,因没 inc 过)
 */
export function applySpawnGuards(
  caller: CallerContext,
  _newCwd: string,
  _newAdapter: string,
  opts?: { handOffMode?: boolean },
): GuardDenial | {
  ok: true;
  parentDepth: number;
  spawnLimits: SpawnSessionLimits;
  fanOutSlot: { release: () => void };
} {
  const settings = settingsStore.getAll();
  const maxDepth = settings.mcpMaxSpawnDepth ?? 3;
  const maxFanOut = settings.mcpMaxFanOutPerParent ?? 10;
  const ratePerMin = settings.mcpSpawnRatePerMinute ?? 20;

  // 0. 同步刷新 RateLimiter 配置（hot-toggle 用户 Settings 立即生效）
  spawnRateLimiter.setLimits(ratePerMin, SPAWN_RATE_WINDOW_MS);

  // parentDepth / fan-out snapshot 始终算：成功和 guard-deny 路径都把当前值与上限返给 caller。
  const parentDepth = sessionRepo.getSpawnDepth(caller.callerSessionId);
  const activeChildren = sessionRepo.listChildren(caller.callerSessionId, 'active').length;
  const initialInFlight = inFlightChildren.get(caller.callerSessionId);
  const attemptedNextDepth = parentDepth + 1;
  const initialLimits = buildSpawnLimits({
    parentDepth,
    nextDepth: attemptedNextDepth,
    activeChildren,
    inFlight: initialInFlight,
    maxDepth,
    maxFanOut,
    rateCurrent: spawnRateLimiter.currentCount,
    rateMax: ratePerMin,
  });

  // 1. depth 上限（不消耗资源，最先）
  // §D4 plan handoff-no-spawn-guards-20260526:handOffMode=true 时跳过本检查
  if (!opts?.handOffMode && parentDepth >= maxDepth) {
    return deny(
      `spawn depth ${parentDepth} >= max ${maxDepth}`,
      `Increase Settings → MCP Server → mcpMaxSpawnDepth (current: ${maxDepth}) if you really need a deeper chain. Default 3 covers lead → teammate → sub-teammate.`,
      initialLimits,
    );
  }

  // 2. fan-out（同步段内 check + inc 防穿透；不消耗 rate token）
  // §D4:handOffMode=true 时整段 fan-out check 跳过(hand-off 平级接力不构成 fork-bomb 风险)
  if (!opts?.handOffMode) {
    const effective = activeChildren + initialInFlight;
    if (effective + 1 > maxFanOut) {
      return deny(
        `fan-out ${effective} reached for parent ${caller.callerSessionId} (max ${maxFanOut})`,
        'Wait for in-flight children to settle, or shutdown some before spawning more. Increase Settings → MCP Server → mcpMaxFanOutPerParent if you genuinely need more.',
        initialLimits,
      );
    }
  }

  // 3. spawn-rate 滑动窗口（**消耗 token**，必须最后；fan-out 通过才扣）
  // §D4 + R2 LOW-3 修法:JS && 短路求值 — handOffMode=true 时 !opts?.handOffMode 为 false,
  // 整个表达式短路不执行 !spawnRateLimiter.tryConsume(),token 不消耗
  // (SlidingWindowRateLimiter.tryConsume 实现内 push to requests array 副作用也跳)
  if (!opts?.handOffMode && !spawnRateLimiter.tryConsume()) {
    const retry = spawnRateLimiter.retryAfterMs();
    const rateDeniedLimits = buildSpawnLimits({
      parentDepth,
      nextDepth: attemptedNextDepth,
      activeChildren,
      inFlight: initialInFlight,
      maxDepth,
      maxFanOut,
      rateCurrent: spawnRateLimiter.currentCount,
      rateMax: ratePerMin,
      retryAfterMs: Math.ceil(retry),
    });
    return deny(
      `app-wide spawn rate exceeded: ${ratePerMin}/min (retry after ${Math.ceil(retry)}ms)`,
      `Wait ~${Math.ceil(retry / 1000)}s before retrying. Increase Settings → MCP Server → mcpSpawnRatePerMinute if you frequently run parallel deep-review.`,
      rateDeniedLimits,
    );
  }

  // §D4 + R1 MED-6 修法:handOffMode=true 时**完全不进 in-flight 计数表** —
  // 不调 inFlightChildren.inc,fanOutSlot.release 退化 no-op(因没 inc 过 dec 也不必要,
  // released=false 短路保护已 by design)
  if (!opts?.handOffMode) {
    inFlightChildren.inc(caller.callerSessionId);
  }
  const reservedInFlight = opts?.handOffMode ? initialInFlight : initialInFlight + 1;
  const spawnLimits = buildSpawnLimits({
    parentDepth,
    nextDepth: attemptedNextDepth,
    activeChildren,
    inFlight: reservedInFlight,
    maxDepth,
    maxFanOut,
    rateCurrent: spawnRateLimiter.currentCount,
    rateMax: ratePerMin,
  });
  let released = false;
  return {
    ok: true,
    parentDepth,
    spawnLimits,
    fanOutSlot: {
      release: () => {
        if (released) return;
        released = true;
        // handOffMode 路径没 inc 过,这里也不调 dec(对称);非 handOffMode 路径正常 dec
        if (!opts?.handOffMode) {
          inFlightChildren.dec(caller.callerSessionId);
        }
      },
    },
  };
}
