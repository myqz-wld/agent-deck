---
plan_id: "mcp-server-hot-reload-investigation-20260515"
created_at: "2026-05-15"
worktree_path: ""
status: "in_progress"
base_commit: "99f1e61"
base_branch: "main"
parent_plan_id: "archive-plan-content-overwritten-fix-20260515"
parent_review_id: "REVIEW_44"
---

# mcp-server-hot-reload-investigation-20260515 — in-process MCP server 不 hot reload 根因调查 + 解决方案设计

## 总目标 & 不变量

调查 Agent Deck 应用内 in-process MCP server 不 hot reload 的根因 + 设计可行解决方案,让 mcp tool handler 代码改动后无需重启 Electron dev / 重新打包 .app 即可生效。

**触发场景**:任何修 mcp tool handler(`src/main/agent-deck-mcp/tools/handlers/*.ts`)+ 想本会话 dogfooding 验证 fix 真生效的场景。本 stub 由 plan archive-plan-content-overwritten-fix-20260515 Phase 4.3 dogfooding 实测撞 + 触发(详 commit 445eace message + REVIEW_44 §dogfooding 关键发现)。

**不变量**:
- 不动 Electron main 进程整体架构(只动 mcp tool handler 加载机制)
- 不破坏 Electron 沙箱模型 / IPC 边界 / Agent Deck core(SessionManager / lifecycle scheduler 等)
- 解决方案必须能区分 dev mode vs production .app(.app 完全无法 hot reload 是预期,dev mode 才需要)

## 设计决策(待调查 + 异构对抗)

下面是 hint level 推荐方向,实施会话需先调查根因再决定具体方案:

### 调查方向(Phase 1)

1. **mcp server 启动姿势**:看 `src/main/agent-deck-mcp/` 入口(server start)在 main 进程哪里挂载 / `bootstrap` 流程哪一步 / 是用什么 transport(in-process Map / stdio / HTTP)
2. **tool handler 加载机制**:`tools/handlers/*.ts` 是 import-time 一次性 register 还是 lazy import 每次 invoke / vite-plugin-electron HMR 对 main process 是否有效(默认 main process 不 HMR,只 renderer HMR)
3. **dev mode vs production .app 行为差异**:dev mode 跑 `pnpm dev` 时 electron-vite 是否对 main process 提供任何 dynamic reload / production .app 是 asar 打包,完全无法 hot reload(这是预期)

### 解决方案 hint level(待调查后决定)

| 方案 | 思路 | 风险 |
|---|---|---|
| **A. Dev-only file watcher + 显式 re-register** | dev mode 跑 chokidar 监 `src/main/agent-deck-mcp/tools/handlers/*.ts`,变更时调 mcp server 内 `re-register-handlers` API(需 mcp server 暴露)+ 重新 `import('./handlers/...').default` 拿新 handler fn 替换内存 Map 的 entry | 需 mcp server lib(`@modelcontextprotocol/sdk` 还是自家 implementation?)支持 dynamic re-register。如不支持,得 fork / monkey-patch / 写 wrapper |
| **B. Tool handler proxy(每次 invoke 重 import)** | mcp server register handler 时不直接 register fn,register 一个 proxy fn 每次 invoke 时 `await import('./handlers/...')` 拿最新 fn 调。Node.js ESM `import()` cache busting 用 `?t=${Date.now()}` query 或 `import.meta.cache.delete` API | 性能损耗(每次 invoke 都过 ESM 解析)。Node ESM cache 可能 key 用 url 不易 bust。dev-only 才用,production 走原姿势 |
| **C. Sub-process MCP server(stdio transport)** | 把 mcp server 从 in-process 改成独立 sub-process(`fork('./agent-deck-mcp/server.ts')`),caller 通过 stdio 通信。dev mode 改 handler 时 kill + restart sub-process(< 1s),production .app 仍打包 sub-process 走 stdio | 大改架构。in-process 现有优势(同进程共享 SessionManager / DB connection)全丢,需要 IPC bridge 同步状态。settings.json 设计 + caller_session_id 传递机制要重做 |
| **D. 接受 known limitation(不修)** | dev 改 mcp tool 后必须重启 dev / 重打包 .app | 当前 status quo。dogfooding 体验差 |

按风险升序 D < A < B < C。优先 A(改动最小,效果直接)。但需先调查 mcp server lib 是否支持 dynamic re-register,不支持降级 B,B 撞 ESM cache 问题降级 D。C 不到万不得已不动。

## 步骤 checklist

### Phase 1: 调查根因

- [ ] **Step 1.1 — 看 mcp server 启动姿势**:`src/main/agent-deck-mcp/index.ts`(或类似入口)+ main `bootstrap.ts` import 链 + 用啥 transport
- [ ] **Step 1.2 — 看 tool handler 加载机制**:register 是 import-time 还是 lazy / 用啥 mcp server lib(@modelcontextprotocol/sdk?自家?)+ 是否支持 dynamic re-register API
- [ ] **Step 1.3 — 看 dev mode hot reload 现状**:`electron.vite.config.ts` 中 main process 是否有任何 watch / reload 配置
- [ ] **Step 1.4 — 用户授权调查方向**:调查结果汇报后,用户决定走方案 A/B/C/D

### Phase 2: 实施(待 Phase 1 完成)

- [ ] **Step 2.1 — 实施选定方案** + 加测试守门(dev mode hot reload 行为 + production .app 仍走原姿势 invariant)

### Phase 3: 异构对抗 review × fix

- [ ] **Step 3.1 — 异构对抗 review**:scope = 实施 diff + 测试 / focus = 方案是否真生效 + 是否破坏 production .app 行为 + 是否引入 race / cluster

### Phase 4: 收口

- [ ] **Step 4.1 — REVIEW_X.md 或并入 CHANGELOG**
- [ ] **Step 4.2 — CHANGELOG_X.md + plans/INDEX.md 同步**
- [ ] **Step 4.3 — `mcp__agent-deck__archive_plan` 自动归档**(dogfooding 终极验证:archive 后 plan 文件 [x] + 测试覆盖 + 本 plan fix 真生效场景)

## 当前进度

- ⬜ stub 创建,**未建 worktree**(本 plan 性质偏调查 + 探索,scope 不确定 — 待 Phase 1 调查后再决定要不要建 worktree;Phase 1 调查纯 read-only 可在 main repo 直接做)
- ⬜ Phase 1 起手:read mcp server 入口 + tool handler register 链

## 下一会话第一步

按 user CLAUDE.md cold-start 流程(本 plan 简化版,无 worktree):

1. `Bash: cat /Users/apple/Repository/personal/agent-deck/plans/mcp-server-hot-reload-investigation-20260515.md` 全文读 plan
2. **不 EnterWorktree**(本 plan 调查阶段无 worktree,scope 确定后 Phase 2 实施前再建)— 直接在 main repo 做 Phase 1 调查
3. 自检 main HEAD ≥ 99f1e61(本 stub 创建时):`git log --oneline -3`
4. **从 Phase 1.1 起手** — read `src/main/agent-deck-mcp/index.ts` + grep main `bootstrap` 找 mcp server 启动姿势
5. Phase 1 调查完成后告诉用户 + 用户决策方案 → Phase 2 实施前若需 worktree 再建

## 已知踩坑

- **mcp server transport 探查**:Agent Deck app SDK 注入的 system prompt 提到「in-process transport 自动 override 真实 session id(无需 caller 显式传)」 — 强暗示是 in-process Map / direct call,不是 stdio。但需 confirmed
- **production .app 不可能 hot reload**:asar 打包后代码在归档内,fs.readFile 不能反过来 write。production .app 的不 hot reload 是预期 + 不可解决,本 plan scope 仅 dev mode
- **Electron main process 默认不 HMR**:vite-plugin-electron 默认 main process 改动需 restart electron。HMR 仅适用 renderer

## 相关 followup

- **archive-plan-tool-ux-followup-20260515**:本 stub 兄弟 plan,REVIEW_44 同主题 followup。本 plan 调查完成后可与之配合(若 mcp hot reload 真修好,archive-plan-tool-ux-followup 收口 dogfooding 直接验证 fix 真生效,无需 manual fix)

## 会话风格授权

承袭 user CLAUDE.md §决策对抗 + 本 plan 性质(调查 + 探索,scope 不确定):
- **Phase 1 调查**:lead 自主推进,完成后告知用户调查结果
- **方案 A/B/C/D 选型**:必须告诉用户征得确认(architectural decision,涉及 production .app 行为不可破坏)
- **session 1 (2026-05-15) 用户授权传递**(原 plan archive-plan-content-overwritten-fix-20260515 起手):「你一路推进吧,hand off 的时机你自己决定」继承
