/**
 * defaultCodexResumeJsonlExists 单测 — REVIEW_56 §F2 修法回归 test
 * (Plan-Review Round 1 + spike1 实证决策 A: 加 fallback 递归扫 fs 兑底)。
 *
 * 测试矩阵:
 * - case 0: same day (typical 99%) → ±1 day fast path hit
 * - case 1: D-1 (±1 day fallback) → fast path hit
 * - case 2: D+1 (±1 day fallback) → fast path hit
 * - case 3: D-2 (跨 ≥ 2 day) → **F2 修法**: recursive scan fallback 命中 (修前 false miss)
 * - case 4: D+2 (跨 ≥ 2 day) → 同 case 3
 * - case 5: 完全不存在的 threadId → 全部 miss return false
 * - case 6: sessionsRoot 不存在 → return false (fail-safe)
 */
import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { join } from 'node:path';
import { mkdirSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { defaultCodexResumeJsonlExists } from '../recoverer';

/**
 * defaultCodexResumeJsonlExists 内部 hardcode ~/.codex/sessions(`join(homedir(), '.codex', 'sessions')`),
 * 测试本身用 tmpdir 隔离 sessions root 需 monkey-patch home? 简化: 跑真路径需用户清理。
 *
 * 折中: 用 process.env.HOME monkey-patch 临时 redirect — node:os homedir() 读 process.env.HOME
 * (mac/linux),tmpdir 子目录创建 `<tmp>/<test-id>/.codex/sessions/<YYYY>/<MM>/<DD>/`。
 */

const TEST_HOME = join(tmpdir(), `recoverer-f2-test-${process.pid}`);
let origHome: string | undefined;

beforeEach(() => {
  origHome = process.env.HOME;
  process.env.HOME = TEST_HOME;
  // 确保 sessions root 不存在初始 (per case 控制)
  rmSync(TEST_HOME, { recursive: true, force: true });
  mkdirSync(TEST_HOME, { recursive: true });
});

afterEach(() => {
  if (origHome !== undefined) process.env.HOME = origHome;
  else delete process.env.HOME;
  rmSync(TEST_HOME, { recursive: true, force: true });
});

function plantJsonl(yyyy: string, mm: string, dd: string, threadId: string): void {
  const dayDir = join(TEST_HOME, '.codex', 'sessions', yyyy, mm, dd);
  mkdirSync(dayDir, { recursive: true });
  const file = join(dayDir, `rollout-2026-05-26T00-00-00-${threadId}.jsonl`);
  writeFileSync(file, '');
}

describe('defaultCodexResumeJsonlExists — REVIEW_56 §F2 修法 (recursive fallback)', () => {
  const tid = '019e5ff7-70b8-7bb3-9a29-d065ed209f40';

  it('case 0: same day (typical 99% case) → ±1 day fast path hit return true', () => {
    plantJsonl('2026', '05', '26', tid);
    const startedAt = new Date(2026, 4, 26, 12, 0, 0).getTime();
    expect(defaultCodexResumeJsonlExists(tid, startedAt)).toBe(true);
  });

  it('case 1: D-1 (startedAt 在 jsonl 前一天) → ±1 day fallback hit return true', () => {
    plantJsonl('2026', '05', '26', tid);
    const startedAt = new Date(2026, 4, 25, 23, 59, 50).getTime();
    expect(defaultCodexResumeJsonlExists(tid, startedAt)).toBe(true);
  });

  it('case 2: D+1 (startedAt 在 jsonl 后一天) → ±1 day fallback hit return true', () => {
    plantJsonl('2026', '05', '26', tid);
    const startedAt = new Date(2026, 4, 27, 0, 0, 10).getTime();
    expect(defaultCodexResumeJsonlExists(tid, startedAt)).toBe(true);
  });

  it('case 3 **F2 修法**: D-2 (跨 ≥ 2 day, ±1 day miss) → recursive scan fallback hit return true', () => {
    plantJsonl('2026', '05', '26', tid);
    const startedAt = new Date(2026, 4, 24, 12, 0, 0).getTime();
    expect(defaultCodexResumeJsonlExists(tid, startedAt)).toBe(true);
  });

  it('case 4 **F2 修法**: D+2 (跨 ≥ 2 day, ±1 day miss) → recursive scan fallback hit return true', () => {
    plantJsonl('2026', '05', '26', tid);
    const startedAt = new Date(2026, 4, 28, 12, 0, 0).getTime();
    expect(defaultCodexResumeJsonlExists(tid, startedAt)).toBe(true);
  });

  it('case 5: 完全不存在的 threadId → recursive 扫完仍 miss return false', () => {
    plantJsonl('2026', '05', '26', tid);
    const startedAt = new Date(2026, 4, 26, 12, 0, 0).getTime();
    const otherTid = '019e9999-aaaa-bbbb-cccc-dddddddddddd';
    expect(defaultCodexResumeJsonlExists(otherTid, startedAt)).toBe(false);
  });

  it('case 6: sessionsRoot 不存在 (HOME/.codex/sessions/) → return false (fail-safe)', () => {
    // 不调 plantJsonl,sessions root 不存在
    expect(existsSync(join(TEST_HOME, '.codex', 'sessions'))).toBe(false);
    const startedAt = new Date(2026, 4, 26, 12, 0, 0).getTime();
    expect(defaultCodexResumeJsonlExists(tid, startedAt)).toBe(false);
  });

  it('case 7: multi-year tree (2025/04 + 2026/05) recursive scan 找到任意 jsonl', () => {
    plantJsonl('2025', '04', '15', tid); // 2025 年的 jsonl
    const startedAt = new Date(2026, 4, 26, 12, 0, 0).getTime(); // 2026-05-26 startedAt
    // ±1 day fast path miss (sessions/2026/05/{25,26,27} 不存在)
    // recursive fallback 扫 2025/04/15 找到 tid jsonl → return true
    expect(defaultCodexResumeJsonlExists(tid, startedAt)).toBe(true);
  });
});
