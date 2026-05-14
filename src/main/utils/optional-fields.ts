/**
 * REVIEW_37 P1-Phase2 (claude F4 LOW): omitUndefined helper —— 收口反复出现的
 * `...(x !== undefined ? { k: x } : {})` 三元 spread 模式。
 *
 * **使用场景**：构造下游 SDK / handler options 对象时，多个字段都是 `T | undefined`，
 * 不想把 undefined 字段送下去（避免下游 `if (opts.foo !== undefined)` 检查 / 防覆盖
 * 已有默认值）。原 inline 写法每个字段一行 spread+ternary 视觉噪音大、易漏一个。
 *
 * **示例**（spawn.ts 老样子 → 新样子）：
 *
 * ```ts
 * // 老
 * adapter.createSession({
 *   cwd: args.cwd,
 *   prompt: ...,
 *   ...(effectivePermissionMode !== undefined ? { permissionMode: effectivePermissionMode } : {}),
 *   ...(effectiveCodexSandbox !== undefined ? { codexSandbox: effectiveCodexSandbox } : {}),
 *   ...(effectiveClaudeCodeSandbox !== undefined
 *     ? { claudeCodeSandbox: effectiveClaudeCodeSandbox }
 *     : {}),
 *   ...(args.team_name !== undefined ? { teamName: args.team_name } : {}),
 * });
 *
 * // 新
 * adapter.createSession({
 *   cwd: args.cwd,
 *   prompt: ...,
 *   ...omitUndefined({
 *     permissionMode: effectivePermissionMode,
 *     codexSandbox: effectiveCodexSandbox,
 *     claudeCodeSandbox: effectiveClaudeCodeSandbox,
 *     teamName: args.team_name,
 *   }),
 * });
 * ```
 *
 * **语义边界**：
 * - 仅过滤严格 `undefined`（含 `void 0`）；`null` / 空字符串 `''` / 空数组 `[]` / 0 / false **保留**
 * - 不递归（嵌套 object 不处理）；浅过滤够用，深结构请单独处理
 * - 不破坏类型 — 返回 `Partial<T>` 让 spread 后类型可推断
 *
 * **何时不用**：
 * - 字段需要「empty array → skip」语义（typical：extra_allow_write 长度=0 时跳过）→ 留 inline `...(arr.length > 0 ? { arr } : {})`
 * - 字段需要「falsy → skip」语义（typical：modelFromFrontmatter 空字符串视作未设）→ 留 inline `...(x ? { x } : {})`
 * - 单字段 spread —— 一行写法本身就清晰，多绕 helper 反而更冗长
 *
 * **形态**：module-level pure function，零依赖，纯 TypeScript。
 */
export function omitUndefined<T extends object>(obj: T): Partial<T> {
  const out: Partial<T> = {};
  for (const k of Object.keys(obj) as (keyof T)[]) {
    if (obj[k] !== undefined) {
      out[k] = obj[k];
    }
  }
  return out;
}
