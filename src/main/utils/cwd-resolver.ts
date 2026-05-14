/**
 * REVIEW_37 P3-C Step 4.1: spawn cwd resolver —— 收口反复出现的
 * `opts.cwd || process.cwd()` / `opts.cwd && opts.cwd.trim() ? opts.cwd : process.cwd()`
 * 两种字面变体，统一到「trim 后非空才用 caller cwd，否则降级到主进程 cwd」语义。
 *
 * **抽出动机**（R1 review C 项 finding）：
 * 3 处 spawn cwd fallback 模式分散字面不一致：
 *   - `codex-cli/sdk-bridge/index.ts`: `opts.cwd && opts.cwd.trim() ? opts.cwd : process.cwd()`
 *     —— 严格版（防 caller 传 "   " 全空白让 SDK 拿 invalid path）
 *   - `oneshot-llm/claude-runner.ts`: `opts.cwd || process.cwd()` —— 宽松版
 *     （`opts.cwd === "   "` truthy 直接传给 SDK，可能让 cli.js 撞 ENOENT）
 *   - `oneshot-llm/codex-runner.ts`: 同上
 *
 * 抽 helper 顺手把 3 处统一到严格版（防 bug + 1 处 SSOT）。对正常调用（绝对路径 cwd）
 * 行为零变化；仅当 caller 传 "   " 全空白时由「传给 SDK」升级为「降级到 process.cwd()」。
 *
 * **使用场景**：spawn SDK / 子进程时 cwd fallback 链最末端 —— 「caller 传了就用，否则用
 * 主进程 cwd 兜底」。**不**适用于复杂 fallback chain（如 `args.cwd > resolved.mainRepo >
 * resolved.worktreePath` 的 hand-off-session.ts plan-driven mode），那种特化逻辑请保留 inline。
 *
 * **示例**：
 *
 * ```ts
 * // 老（codex sdk-bridge）
 * const cwd = opts.cwd && opts.cwd.trim() ? opts.cwd : process.cwd();
 *
 * // 老（claude/codex runner）
 * cwd: opts.cwd || process.cwd(),
 *
 * // 新（统一）
 * const cwd = resolveSpawnCwd(opts);
 * cwd: resolveSpawnCwd(opts),
 * ```
 *
 * **语义边界**：
 * - cwd `undefined` / `null` / `''` / `'   '`（trim 后空）→ `process.cwd()`
 * - cwd `'/Users/foo'` / `'/Users/foo  '`（含两端空白但 trim 非空）→ 原值（**不 trim**，保留
 *   caller 输入完整字符串；下游 SDK 自己 normalize）
 * - 只看 `opts.cwd` 一个字段；不嗅探其他 fallback（mainRepo / worktreePath 等特化场景留 inline）
 *
 * **形态**：module-level pure function，零依赖（仅 `process.cwd()`），纯 TypeScript。
 */
export function resolveSpawnCwd(opts: { cwd?: string | null }): string {
  const raw = opts.cwd;
  if (raw && raw.trim()) return raw;
  return process.cwd();
}
