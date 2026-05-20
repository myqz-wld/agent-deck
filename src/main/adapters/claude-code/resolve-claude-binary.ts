/**
 * Claude CLI 二进制路径解析(plan add-claude-cli-path-override-and-bump-sdks-20260520
 * Follow-up F2 + F3 抽 helper)。
 *
 * 抽出动机:
 * - F2 加 existsSync 护栏(deviates plan §D7 「不加 existsSync,镜像 codex」决策):user 填错
 *   路径时 silently fallback + console.warn,不让 SDK spawn 直接撞 ENOENT
 * - F3 加 priority chain 单元测试(plan §D8 §1.7 「可选,Phase 1 自决,不强求」):为让单测
 *   不依赖 sdk-bridge / claude-runner 全 mock 巨型 boilerplate,抽 helper 让 priority chain
 *   逻辑可独立测(deviates plan §D5 「inline 不抽 helper,镜像 codex N=2」决策)
 *
 * 两个 deviation 都是 user 显式 opted-in follow-up(plan §D5 + §D7 原 design 仍在 plan 文档
 * 内,但 follow-up phase 引入此 helper 覆盖更新)。
 *
 * 优先级链:
 * - `settingsStore.get('claudeCliPath')` 非空(trim 后)+ existsSync 通过 → 用 user 路径
 * - 否则 → fallback `getPathToClaudeCodeExecutable()` (bundled SDK binary unpacked path)
 *
 * 边界 case(spike3 §B1 完整覆盖 + F2 加 existsSync 行为):
 * - `null` → falsy → fallback
 * - `""` → falsy → fallback
 * - `"   \t  "` → trim 后空 → falsy → fallback
 * - `"/path"` + path 不存在 → existsSync false → fallback + console.warn
 * - `"/path"` + path 存在 → user override
 * - `"  /path  "` + path 存在 → trim 后的 path 用作 override(user-friendly,filepicker 残留空白不让 spawn 失败)
 *
 * 不直接放 sdk-runtime.ts:保持 sdk-runtime pure utility 不引 settingsStore / fs 依赖
 * (plan §D5 局部原则保留)。
 */
import { existsSync } from 'node:fs';
import { settingsStore } from '@main/store/settings-store';
import { getPathToClaudeCodeExecutable } from '@main/adapters/claude-code/sdk-runtime';

export function resolveClaudeBinary(): string | undefined {
  const claudeCliPath = settingsStore.get('claudeCliPath');
  const userOverride = claudeCliPath && claudeCliPath.trim();
  if (userOverride) {
    if (existsSync(userOverride)) {
      return userOverride;
    }
    console.warn(
      `[claudeCliPath] user override "${userOverride}" not found, falling back to bundled binary`,
    );
  }
  return getPathToClaudeCodeExecutable();
}
