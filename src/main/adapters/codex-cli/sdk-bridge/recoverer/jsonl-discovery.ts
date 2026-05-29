/**
 * Phase 4 Step 4.3 jsonl 探测 helper — codex jsonl 发现 + cwd 存在性默认实现。
 *
 * 3 export helper + 1 internal helper(从 recoverer.ts L489-end 抽出):
 * - `defaultCodexResumeJsonlExists`: facade.codexResumeJsonlExists 默认实现 (扫
 *   ~/.codex/sessions/<YYYY>/<MM>/<DD>/ 找匹配 thread_id 的 rollout 文件)
 * - `findThreadJsonlByRecursiveScan`: internal helper,±1 day fast path miss 后递归扫
 *   sessionsRoot 兜底 (REVIEW_56 §F2 修法)
 * - `defaultCwdExists`: facade.cwdExists 默认实现 (fs.existsSync,fail-safe 返 true)
 *
 * **codex CLI jsonl 路径规则**:
 *   `~/.codex/sessions/<YYYY>/<MM>/<DD>/rollout-<TIMESTAMP>-<thread_id>.jsonl`
 *   YYYY/MM/DD = codex 创建 thread 时的本地日期；TIMESTAMP = 同时刻 ISO 字符串
 *
 * **facade re-export**: recoverer.ts facade re-export 3 export helper 保 byte-identical
 * external import path (`from './recoverer'` caller 站点零变更继续工作)。
 */
import { existsSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

/**
 * 默认 codex jsonl 探测 — 扫 ~/.codex/sessions/<YYYY>/<MM>/<DD>/ 找匹配 thread_id 的 rollout 文件。
 *
 * **算法**：
 * 1. 用 sessionRepo.startedAt 算 createdAt Date（应用 emit session-start 时取的 Date.now()，
 *    与 codex 自己写 jsonl 的时刻通常差 < 几秒；同日的概率 99%+）
 * 2. 扫 `<sessions>/<YYYY>/<MM>/<DD>/` 找文件名 endsWith `-<thread_id>.jsonl`
 * 3. 找不到就再试 ±1 day（覆盖时区边界 / startedAt 与 codex 实际写 jsonl 的时刻跨日的边角）
 * 4. **REVIEW_56 §F2 修法 (Plan-Review Round 1 + spike1 实证)**: ±1 day fast path miss 后
 *    递归扫整个 sessionsRoot 兑底（覆盖跨 ≥ 2 day false miss 边角:abnormal scenario 如
 *    application crash 长延迟 / 错误 startedAt persist 等）。spike1 实测 1800 files 递归扫
 *    0.052ms / wrong-startedAt fast-path 0.007ms < 1ms 完全可接受
 *    (spike-reports/spike1-jsonl-cross-day.md §case 3/4 + fs 开销 benchmark)
 * 5. 任意异常（fs 权限 / 路径解析失败）→ 返回 true（让 SDK 自己 try，最差不过原行为）
 *
 * 这是 facade.codexResumeJsonlExists 的默认实现；test 通过 extend facade override 该方法
 * 让单测不依赖真 ~/.codex/sessions 目录。
 */
export function defaultCodexResumeJsonlExists(threadId: string, startedAt: number): boolean {
  try {
    const sessionsRoot = join(homedir(), '.codex', 'sessions');
    if (!existsSync(sessionsRoot)) return false;

    const startDate = new Date(startedAt);
    // 扫 startedAt 当天 + ±1 day（共 3 天）覆盖时区边界 — fast path 99%+ 场景
    for (const dayOffset of [0, -1, 1]) {
      const d = new Date(startDate.getTime() + dayOffset * 86_400_000);
      const yyyy = d.getFullYear().toString();
      const mm = (d.getMonth() + 1).toString().padStart(2, '0');
      const dd = d.getDate().toString().padStart(2, '0');
      const dayDir = join(sessionsRoot, yyyy, mm, dd);
      if (!existsSync(dayDir)) continue;
      const files = readdirSync(dayDir);
      if (files.some((f) => f.endsWith(`-${threadId}.jsonl`))) return true;
    }

    // REVIEW_56 §F2 修法: ±1 day miss 后递归扫整个 sessionsRoot 兑底 (跨 ≥ 2 day false miss
    // 覆盖,典型场景需 abnormal scenario,概率低但发生时用户失对话历史,值得 fallback 修)。
    // spike1 实测 fs 开销 < 1ms 完全可接受。
    return findThreadJsonlByRecursiveScan(sessionsRoot, threadId);
  } catch {
    // 任意异常退化返回 true(让 createSession 自己 try),最差不过原行为
    return true;
  }
}

/**
 * **REVIEW_56 §F2 修法**: 递归扫 sessionsRoot/<YYYY>/<MM>/<DD>/ 找 endsWith `-<threadId>.jsonl`
 * 文件。±1 day fast path miss 后兑底用,覆盖跨 ≥ 2 day false miss 边角。
 *
 * 三层 readdirSync (year / month / day),每层 try/catch 跳过非目录 entries (容错)。
 * spike1 实测 1800 files (2y × 6m × 30d × 5f/day) 0.052ms,100k files 估算 < 5ms。
 */
function findThreadJsonlByRecursiveScan(sessionsRoot: string, threadId: string): boolean {
  let years: string[];
  try {
    years = readdirSync(sessionsRoot);
  } catch {
    return false;
  }
  for (const y of years) {
    const yPath = join(sessionsRoot, y);
    let months: string[];
    try {
      months = readdirSync(yPath);
    } catch {
      continue;
    }
    for (const m of months) {
      const mPath = join(yPath, m);
      let days: string[];
      try {
        days = readdirSync(mPath);
      } catch {
        continue;
      }
      for (const d of days) {
        const dPath = join(mPath, d);
        let files: string[];
        try {
          files = readdirSync(dPath);
        } catch {
          continue;
        }
        if (files.some((f) => f.endsWith(`-${threadId}.jsonl`))) return true;
      }
    }
  }
  return false;
}

/**
 * cwd 存在性 thunk 的默认实现 — 直接走 fs.existsSync（与 claude `defaultCwdExists` 同款）。
 *
 * 这是 facade.cwdExists 的默认实现;test 通过 extend facade override 让单测不依赖真 fs。
 *
 * **fail-safe 退化**:任意异常退化返回 true(让 createSession 自己 try),最差不过原行为。
 */
export function defaultCwdExists(cwd: string): boolean {
  try {
    return existsSync(cwd);
  } catch {
    return true;
  }
}
