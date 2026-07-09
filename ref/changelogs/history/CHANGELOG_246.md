# CHANGELOG_246

## MCP plan review tool

## 概要

新增 `request_plan_review` MCP tool，给 Codex 等没有原生 Plan mode 的 adapter 使用。模型需要用户先检阅计划时，可以把 markdown plan 交给 Agent Deck，应用复用现有 ExitPlanMode 待处理 UI，用户批准后 tool 返回 `approved`，要求修改时返回 `revise` 和反馈。

## 变更内容

- MCP registry 从 16 个公开 tool 扩到 17 个，新增 `request_plan_review` schema / handler / external deny 守门。
- 新增 `planReviewService`，把 MCP plan review 转成 `waiting-for-user` 事件和现有 `exit-plan-mode` pending 数据结构，并支持 approve / revise / timeout。
- Codex 侧适配：`respondExitPlanMode` IPC 先尝试消费 MCP plan review，再回退 adapter 原生 ExitPlanMode；pending snapshot 同时合并 adapter pending 与 MCP plan review pending。
- UI 优化：MCP plan review 不展示权限模式切换；计划内容长时限制高度并提供展开，markdown 渲染改为 memoized 组件，降低待处理列表重复渲染成本。
- 顺手修掉 `pnpm build` 的 Vite dynamic/static import warning：`manager-team-coordinator` 不再 lazy import 已被多处静态引用的 `agentDeckTeamRepo`。
- README、Claude/Codex 应用约定、设置页 MCP tool 列表、PlantUML 架构/流程图同步到 17 public tools。

## 验证

- `pnpm typecheck`
- `pnpm vitest run src/main/agent-deck-mcp/__tests__/request-plan-review.handler.test.ts`
- `pnpm vitest run src/main/agent-deck-mcp/__tests__/helpers.deny-external.test.ts src/main/agent-deck-mcp/__tests__/task-external-caller.test.ts`
- `pnpm vitest run src/main/agent-deck-mcp/__tests__/tools.test.ts`
- `pnpm vitest run src/main/session/__tests__/manager-team-coordinator.test.ts src/main/session/__tests__/manager-public-api.test.ts`
- `plantuml --check-syntax ref/architecture/agent-deck-mcp-architecture.puml ref/flows/agent-deck-mcp-tool-call-flow.puml`
- `pnpm build`
