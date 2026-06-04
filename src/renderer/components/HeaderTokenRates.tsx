import { useRef, type JSX } from 'react';
import { useTokenUsageStore } from '../stores/token-usage-store';
import { useTokenRatesPoll } from '../hooks/use-token-rates-poll';
import { useContainerWidth } from '../hooks/use-container-width';
import { buildFreshLiveByBucket, rankLiveAwareBuckets } from '../lib/live-rate';
import { normalizeModel, WINDOW_MS } from '@shared/model-normalize';
import type { TokenRateRow } from '@shared/types';

/**
 * Header 中部「Top3 模型输出 token/s」（plan model-token-stats-and-dashboard-20260602 §Phase 3 R3）。
 *
 * 需求1：顶栏中间显示当前输出速率最高的 Top3 模型 token/s。
 * - **Top3 排名**：当前 tok/s 降序（生成中 fresh live 估算优先，其次 60s 窗口 rates）。
 * - **token/s**：生成中用 display-only 估算 tick；否则该 bucket 最近 60s 窗口 output 总量 ÷ 60。
 * - **响应式隐藏**（需求3）：容器宽度 < 阈值时整区 return null（header 已挤：红绿灯让位 + 6 tab +
 *   图标，Top3 区最先退化）。两级退化：≥ FULL 显示 3 个、[ONE, FULL) 显示 1 个、< ONE 隐藏。
 *
 * **毛玻璃约定**（CLAUDE.md）：不自带 backdrop-filter / 不透明底（避免二次模糊），复用
 * text-deck-muted / tabular-nums 等 token，与 header 其他元素同款轻量样式。
 */

// 阈值（plan §响应式，需真实布局目测校准；当前按 min-width 380 / default 520 + 6 tab 估）
const HEADER_TOPRATES_FULL_PX = 620; // ≥ 此宽显示 Top3
const HEADER_TOPRATES_ONE_PX = 470; // ≥ 此宽显示 Top1；< 此宽隐藏

/** rate row → token/s（output ÷ 窗口秒数）。 */
function toRate(row: TokenRateRow): number {
  return row.outputTokens / (WINDOW_MS / 1000);
}

/** 格式化 token/s：< 10 保留 1 位小数，否则整数（避免 "0.0" 噪声 + 大数字简洁）。 */
function fmtRate(tps: number): string {
  if (tps <= 0) return '0';
  return tps < 10 ? tps.toFixed(1) : Math.round(tps).toString();
}

export function HeaderTokenRates(): JSX.Element | null {
  const containerRef = useRef<HTMLDivElement>(null);
  const width = useContainerWidth(containerRef);
  // header 区域常驻拉取（数据页打开时 header 在 detail 下不渲染，但 live 视图常显 → poll 跟随挂载）
  useTokenRatesPoll();
  const topToday = useTokenUsageStore((s) => s.topToday);
  const rates = useTokenUsageStore((s) => s.rates);
  const liveBySession = useTokenUsageStore((s) => s.liveBySession);

  // 容器太窄 → 整区隐藏（width===null 视为未知，先按可显示渲染，避免首帧误隐藏闪烁）。
  // 注意：ref 必须始终挂在一个真实 DOM 节点上才能被 ResizeObserver 观测；这里用一个 0 宽
  // 占位 wrapper 持 ref，内部内容按宽度条件渲染。
  const maxItems =
    width === null ? 3 : width >= HEADER_TOPRATES_FULL_PX ? 3 : width >= HEADER_TOPRATES_ONE_PX ? 1 : 0;

  // 按当前 tok/s 排名；today 仅用于 tooltip 背景信息。
  const freshLiveByBucket = buildFreshLiveByBucket(liveBySession, Date.now());
  const rateByBucket = new Map(rates.map((r) => [r.bucketKey, toRate(r)]));
  const todayByBucket = new Map(topToday.map((r) => [r.bucketKey, r.outputTokens]));
  const top = rankLiveAwareBuckets(freshLiveByBucket, rates).slice(0, Math.max(maxItems, 0));

  return (
    <div ref={containerRef} className="min-w-0 flex-1 overflow-hidden">
      {maxItems > 0 && top.length > 0 ? (
        <div className="flex items-center justify-center gap-2 overflow-hidden">
          {top.map((bucketKey) => {
            const liveTps = freshLiveByBucket.get(bucketKey);
            const tps = liveTps ?? rateByBucket.get(bucketKey) ?? 0;
            const name = normalizeModel(bucketKey).displayName;
            const todayOutput = todayByBucket.get(bucketKey) ?? 0;
            return (
              <span
                key={bucketKey}
                className="flex shrink-0 items-center gap-1 text-[10px] text-deck-muted"
                title={`${name}：${liveTps !== undefined ? '实时估算' : '最近 60s'} ${fmtRate(tps)} tok/s（今日输出 ${todayOutput.toLocaleString()} tokens）`}
              >
                <span className="max-w-[88px] truncate text-deck-text/80">{name}</span>
                <span className="tabular-nums text-status-working">{fmtRate(tps)}</span>
                <span className="text-deck-muted/60">tok/s</span>
              </span>
            );
          })}
        </div>
      ) : null}
    </div>
  );
}
