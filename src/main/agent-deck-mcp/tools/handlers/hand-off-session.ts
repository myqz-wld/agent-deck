/**
 * hand_off_session handler facade（plan deep-project-review-comprehensive-20260528 Step 4.1
 * 拆分产物，原 1306 LOC handler 文件按功能领域拆为 facade + 4 子模块；本文件为薄 re-export
 * 入口，保持原 import path 不变让 test / mcp tool 注册路径不感知）。
 *
 * **拆分布局**（plan §D5 facade pattern）：
 * - facade（本文件，~80 LOC）：re-export handOffSessionHandler / resolveBatonRoleForSpawn
 *   + HandOffSessionHandlerDeps 接口；外部 import path 全保留
 * - hand-off-session/_deps.ts：共享 HandOffSessionHandlerDeps 接口（避免 facade ↔ handler-main
 *   类型循环）
 * - hand-off-session/cwd-resolver.ts：caller cwd 反查 + mergeCallerCwd + planModeDefaultCwd /
 *   worktreeExists 决策 / extraAllowWrite 推导
 * - hand-off-session/team-adopt-coordinator.ts：N2.c 互斥校验 + N5 fail-fast + adoptedSnapshot
 *   装配 + cold-start prompt prepend + phase 1.5 swapLead loop + processSwappedTeam helper
 * - hand-off-session/task-reassign-coordinator.ts：task ownership 三态分流（skip /
 *   clear-team / preserve-team）+ preserve-team safety 差集算法
 * - hand-off-session/handler-main.ts：handler 主入口串联 4 子模块（impl resolve → cwd 推导 →
 *   adopt precheck/装配 → spawn → phase 1.5 swap → task 过继 → baton cleanup → ok return）
 *
 * **设计要点**（与原文件 byte-identical 语义）：
 *
 * 1. **deny external caller**（types.ts: EXTERNAL_CALLER_ALLOWED.hand_off_session = false）：
 *    起 SDK session 的 fork bomb 风险（同 spawn_session / archive_plan），绝不允许 stdio
 *    external client 调用。withMcpGuard 在 handler-main 内统一拦截。
 *
 * 2. **CHANGELOG_97 baton 语义**：plan 接力的本质是「caller 把 baton 单向交出，新 session
 *    独立接手，原 caller 退出」，**不是**「派出小弟干活，原 caller 当 lead 持续监督」。
 *    default 不传 teamName 给 spawn / default 自动归档 caller。adoptTeammates: true 时
 *    走独立 phase 1.5 adopt 路径接管 teammate（详 team-adopt-coordinator.ts jsdoc）。
 *
 * 3. **CHANGELOG_99 双模式**：planId 可选 — 传则走 plan-driven 模式（读 plan frontmatter +
 *    cold-start prompt）；不传则走 generic 模式（caller 自行装配 prompt + cwd）。
 *
 * 4. **业务行为分层**：plan resolve / frontmatter parse / cold-start prompt 构造在
 *    hand-off-session-impl.ts；spawn 行为复用 spawnSessionHandler；teammate shutdown +
 *    archive caller 复用 baton-cleanup.ts runBatonCleanup helper。
 */

export { handOffSessionHandler, resolveBatonRoleForSpawn } from './hand-off-session/handler-main';
export type { HandOffSessionHandlerDeps } from './hand-off-session/_deps';
