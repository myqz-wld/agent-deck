# CHANGELOG_233: MCP handoff / worktree contract redesign

## 概要

Agent Deck MCP 会话接力和 worktree 工具改为 plan-free primitives：`hand_off_session` 只做 session baton，`enter_worktree` 基于显式本地分支创建 worktree，`exit_worktree` 默认清理 worktree 目录并保留分支。`archive_plan` 和 `shutdown_baton_teammates` 从公开 MCP registry 移除，项目计划归档交给当前项目或 active skill 编排。

## 变更内容

- MCP registry 从 18 个公开工具收敛到 16 个公开工具：6 session、2 worktree、5 task、3 issue。
- `hand_off_session` 删除 `planId` / `planFilePath` / `phaseLabel` / `teamName` / `archiveCaller` / `adoptTeammates` / `teamTaskPolicy` 等参数；`prompt` 必填，计划路径、`/tmp` 上下文文件和下一步要求直接写进 prompt。
- `hand_off_session` 默认 spawn successor、转移 caller 的 worktree marker / task owner / team membership，然后 close caller；资源转移失败时返回 error 且不 close caller，已完成的子步骤会在失败路径回滚，避免成功外观下丢 team/task 权限。spawn 仍保持独立 session 创建职责。
- `enter_worktree` 改为必传 `baseBranch`，从 `refs/heads/<baseBranch>` 当前 commit 创建新 work branch；不再读取 plan frontmatter 或 `.claude` 目录约定。
- `exit_worktree` 移除 `action`，默认删除 worktree 目录并保留 branch；dirty worktree 默认拒绝，`deleteBranch` 显式 opt-in。
- Claude/Codex 应用约定同步更新，去掉 plan-driven handoff / archive tool / shutdown escape hatch 约定，明确项目组织由项目或 skill 承担。
- 更新 handoff / archive-plan / MCP 顶层 / sdk-bridge 相关 PlantUML 与 INDEX；archive-plan 图标为 archived 历史边界。
- 删除旧 handoff/adopt/archive/task-policy 测试，重建新契约测试；新增 resource-transfer coordinator 测试覆盖 lead/team/task/marker 成功路径、failure short-circuit、multi-team partial mutation rollback、task/marker rollback；更新 HandOffMetadata fixture。
- simple-review Round 1 修复：根 README 同步 16-tool 口径；资源转移失败不再 close caller。
- simple-review Round 2 修复：team transfer 子循环改为 preflight + rollback，且整体资源过继按 marker → task → team 顺序执行；team 失败会反向恢复 task owner 和 worktree marker，task 失败会反向恢复 marker。
- simple-review Round 3 收口：reviewer-codex 与 reviewer-claude 均 PASS，未发现新的 CRITICAL/HIGH/MEDIUM。

## 验证

- `pnpm typecheck`
- `pnpm test:node src/main/agent-deck-mcp/__tests__/hand-off-session.handler.test.ts src/main/agent-deck-mcp/__tests__/hand-off-session.resource-transfer.test.ts src/main/agent-deck-mcp/__tests__/enter-exit-worktree.test.ts src/main/agent-deck-mcp/__tests__/tools.test.ts src/main/adapters/codex-cli/__tests__/teammate-spawn-defaults.test.ts`（91 passed）
- `git diff --check`
- `pnpm build`
- PlantUML `@startuml` / `@enduml` 配对检查通过；本机 `plantuml -syntax` 对最小合法样例也返回 50 且无诊断，未作为失败判据。
