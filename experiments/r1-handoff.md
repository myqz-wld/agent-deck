# R1 Handoff — 给下一个会话

> 上一会话完成 plan v3 R1 阶段共 14 commit + 5 spike + 2 CHANGELOG，全 typecheck +
> 241 vitest 通过。本文件交付下一个会话或人工接力。

## TL;DR

- **Plan**：`/Users/apple/.claude/plans/magical-puzzling-muffin.md`（v3 用户已批准 + bypassPermissions）
- **Spike 报告**：`experiments/spikes/SPIKE_REPORT.md`（5 项假设全 ✅）
- **R1 已 ship**：A1 / A2 / A3 / A4 / A7 / A8 / A9 / D1 / D2 / D4 / D5 / D6（共 12 项任务，14 commit）
- **R1 follow-up**：A5 / D7（dep R2.B'4）/ D3（reviewer-* codex skill 内容创作）/ A2c 已做 / A4b 已做 minimal 版本
- **下一阶段**：R2（Agent Deck MCP server，B'0 ADR + 9 任务）→ R3（team 硬切，E0 ADR + 11 任务）→ R4（Generic-PTY，5 任务）

## R1 已 ship 14 commit

Worktree：`/Users/apple/Repository/personal/agent-deck/.claude/worktrees/r1-codex-parity/`
Branch：`worktree-r1-codex-parity`（基于 `main`）

| Commit | 阶段 | 内容 |
|---|---|---|
| `da7f224` | A1 | codex item.updated 增量打开 + UI in-place upsert + tool-use-end status 红色 |
| `490f3b4` | A2a | codex sandbox 持久化（DB v008 + sessionRepo + resume 透传） |
| `ed73637` | A2b | codex sandbox 冷切（capability + bridge.restartWithCodexSandbox + IPC） |
| `a748af1` | A3 | Summarizer 跨 adapter dispatch + codex SDK oneshot runner |
| `ff61b5a` | A4a | ~/.codex/config.toml mcp_servers TOML writer + 13 tests |
| `f33e01a` | A9 | agent-deck CLI `--adapter codex/claude` alias + `--codex-sandbox` |
| `a64eee4` | A7 | CHANGELOG_61 + SPIKE_REPORT.md |
| `fb28bb7` | A8 | codex-cli translate.ts 24 单测 |
| `32b6923` | A2c | SessionDetail Codex sandbox 切档下拉 |
| `09f58a3` | A4b | Codex MCP servers 配置 UI（minimal JSON 编辑） |
| `785e5f5` | D1+D5 | AGENTS.md 注入 Agent Deck 段（HTML 注释 marker 包裹） |
| `d0693b0` | D2 | skills 同步到 ~/.codex/skills/agent-deck/ |
| `44ad9e4` | D4 | Codex 注入 Settings UI section（双 toggle） |
| `f6cf0a7` | docs | CHANGELOG_62 R1.D 收口 |

## R1 已知 follow-up

| Task | 状态 | 何时做 |
|---|---|---|
| **A5** | ⏸️ dep R2.B'4 | R2 阶段 codex 自动注入 Agent Deck MCP server |
| **D7** | ⏸️ dep R2.B'4 | R2 阶段 `<userData>/codex-runtime/config.toml` 与用户主 config 协同 |
| **D3** | ✏️ 内容创作 | reviewer-claude / reviewer-codex 改写为 codex skill 形态 SKILL.md（codex 端用户调 `/agent-deck:reviewer-*` 触发对应 skill） |
| A4c | ✏️ polish | A4b 是 JSON textarea 编辑，可升级为 per-server form（add / edit / remove 行 + stdio vs http transport 切换） |

## 验证步骤（R1 完整通过）

```bash
cd /Users/apple/Repository/personal/agent-deck/.claude/worktrees/r1-codex-parity

# 1. 静态（已通过；接力 session 重跑确认）
zsh -i -l -c "pnpm typecheck"
zsh -i -l -c "pnpm vitest run"  # 241 passed | 26 skipped (task-repo binding 不兼容自动跳)

# 2. dev 端实测（注意：bootstrap step 7.0 会真实写入 ~/.codex/AGENTS.md 和
#    ~/.codex/skills/agent-deck/，这是 D1/D2 设计行为；toggle off 会清掉）
zsh -i -l -c "pnpm dev"
```

实测清单（每条对应 R1 ship 内容）：

- **A1**：起 codex 会话 → 跑 `npm test` 看 stdout 实时增量更新（不噪音）+ 跑 `false` 看 ToolEndRow 红色边框 + "失败" 字样 + exit 1 badge
- **A2c**：codex 会话 SessionDetail 顶部 sandbox 下拉切到 read-only → 让 codex 试 `rm` 看 OS 拒（Operation not permitted）+ 切回 workspace-write 可以写
- **A3**：起 codex 会话 5 分钟 → SessionDetail summary section 出现非 fallback 摘要（不是「最近 N 条事件」）
- **A4b**：Settings → Codex MCP Servers → 编辑 JSON `[{"name":"foo","command":"node"}]` → 保存 → 看 `~/.codex/config.toml` marker 段写入
- **A9**：终端跑 `agent-deck new --adapter codex --prompt ping` → 应起 codex 会话（注意 `unset ELECTRON_RUN_AS_NODE` 见 CLAUDE.md 打包节）
- **D1**：dev 启动后看 `cat ~/.codex/AGENTS.md` → 顶部应有 `<!-- === Agent Deck START === -->` marker 段含 CLAUDE.md 内容
- **D2**：dev 启动后看 `ls ~/.codex/skills/agent-deck/` → 应有 `deep-code-review/SKILL.md` 和 `hello-from-deck/SKILL.md`
- **D4**：Settings → Codex 注入 → 关 toggle → 看 `~/.codex/AGENTS.md` 段被移除 / `~/.codex/skills/agent-deck/` 目录被清

## Merge

验证通过后任选一种：

```bash
cd /Users/apple/Repository/personal/agent-deck

# 选项 a：fast-forward（线性历史，推荐如果 main 没新 commit）
git merge --ff-only worktree-r1-codex-parity

# 选项 b：合并 commit（保留 R1 阶段标记）
git merge --no-ff worktree-r1-codex-parity \
  -m "merge: R1 codex adapter 能力对齐 + 配置生态对齐 (14 commit)"

# 清理 worktree（merge 后）
git worktree remove .claude/worktrees/r1-codex-parity
git branch -d worktree-r1-codex-parity
```

## 接下来 — plan v3 剩余 3 大阶段

按 plan v3 优先级排序（R2 必须先做，因为是 R3 的 wire protocol 草案 + 是 R1.A5/D7 的依赖）：

### R2 — Agent Deck MCP server（2-3 周工期）

**目标**：让 Claude / Codex / 任何支持 MCP 的 agent 通过 MCP 编排其他 adapter session
（spawn / send_message / wait_reply / shutdown / list）。

**5 个 spike 已确认**：
- HTTP transport 集成 fastify ~80 LOC（spike-B'-wire ✅）
- caller_session_id 必须强制 input schema + in-process closure 覆盖（spike-B'-caller-id ⚠️ 应对确认）

**B'0 ADR 必须先做**（plan v3 详定义）：
- transport 三协议（claude in-process + HTTP + stdio）
- 5 个 tool 完整 schema（含 caller_session_id 必填）
- wait_reply 三档 until 语义（idle / turn_complete / first_message）
- 防递归 4 条规则（depth ≤3 / 同 cwd realpath / per-app spawn-rate / per-parent fan-out）
- HookServer onRequest 加 /mcp 前缀分支 + 独立 token
- 替代老 Claude builtin team tools 语义映射文档

**新 worktree**：建议名 `r2-mcp-server`，从 main（merge 后）切：

```bash
cd /Users/apple/Repository/personal/agent-deck
git worktree add .claude/worktrees/r2-mcp-server -b r2-mcp-server main
```

下一会话进入 worktree 后给 prompt：

```
按 plan v3 推 R2 (B' Agent Deck MCP server)。先出 B'0 ADR (docs/agent-deck-mcp-protocol.md)，
然后逐任务一 commit 推 B'1 transport / B'2.a 同步 tool / B'2.b wait_reply / B'3 claude 自动挂 /
B'4 codex 走 HTTP / B'5 鉴权 + 防递归 / B'6 Settings UI / B'7 文档收口。

参考：
- plan v3: /Users/apple/.claude/plans/magical-puzzling-muffin.md
- spike 报告: experiments/spikes/SPIKE_REPORT.md (B'-wire / B'-caller-id 项)
- 完整范本: src/main/task-manager/server.ts + tools.ts + UI McpTasksSection.tsx
- HookServer: src/main/hook-server/server.ts (auth 扩展位)
- R1.A5 + R1.D7 跟 B'4 同时做（codex runtime config 协同 + 自动注入 mcp server）
```

### R3 — team 抽象硬切脱钩 Claude Code Agent Teams（3-4 周，**最大重构**）

**目标**：删除 inbox 协议依赖（~1700 LOC），新建 agent-deck-universal team backend，
让 team 真正成为 adapter-agnostic first-class 容器。

**用户决策（plan v3 已拍板）**：硬切，无双轨过渡期。

**已知必须删的代码清单**（写在 plan v3 E0 ADR 节）：
- `src/main/teams/inbox-watcher.ts` (452)
- `src/main/teams/team-coordinator.ts` (313)
- `src/main/teams/inbox-protocol.ts` (306)
- `src/main/teams/auto-approve.ts` (117)
- `src/main/teams/team-watcher.ts` (152)
- `src/main/teams/team-fs.ts` (334) — 保留 `exportLegacyTeamConfig` 给 E12 用
- `src/main/adapters/claude-code/hook-routes.ts:107-130` 三个 team hook
- `src/shared/types/team.ts` 老类型重写
- `src/renderer/components/{TeamHub,TeamDetail,TeamPending}.tsx` 重写

**E0 ADR 必须先做**（plan v3 详定义）：
- AgentDeckTeam 数据模型（无 backend 字段，只一种 backend）
- TeamRepo + MessageRepo 接口（无 backend 抽象层，直接 SQL）
- AgentAdapter 加 canCollaborate / receiveTeammateMessage / notifyTeammateEvent
- DB migration v009：3 新表 + 标 sessions.team_name deprecated
- agent-deck-mcp 接管所有 cross-adapter 协作（B' 5 tool）

**风险高**：deep-code-review SKILL.md 重写时间窗 + Claude Code CLI 内自起 team agent-deck 完全失明。详见 plan v3「⚠ 用户决策落地后的硬切代价」节。

**E5/E6/E11 必须同 PR 落地**（plan v3 风险节）：避免「新 backend 还没起来 + 老的没了」窗口。

### R4 — Generic-PTY adapter（1-2 周，可推迟到下一季度）

**目标**：把现状 30 行占位的 `src/main/adapters/generic-pty/index.ts` 实现为 PTY 通用 CLI 适配器，
让任何能接受 stdin prompt → stdout response 的 CLI（aider / continue / crush）都能跑。

低保真兜底（拿不到结构化事件流），UI 体验跟 claude / codex 差一档。

## 关键文件备查

R1 ship 涉及的关键文件，下一会话改 codex / settings / sdk-bridge 时备查：

```
src/main/adapters/codex-cli/
├── index.ts                          # adapter 入口 + capabilities + restartWithCodexSandbox 委托
├── translate.ts                      # ThreadEvent → AgentEvent 翻译（含 A1 item.updated 增量）
├── summarizer-runner.ts              # A3 codex SDK oneshot 总结
├── sdk-bridge/
│   ├── index.ts                      # bridge facade + restartWithCodexSandbox 实现
│   ├── thread-loop.ts                # turn loop（不动）
│   ├── codex-binary.ts               # 路径解析（不动）
│   └── types.ts                      # 内部类型
└── __tests__/
    └── translate.test.ts             # A8 24 tests

src/main/codex-config/                 # R1 新建模块
├── toml-writer.ts                    # A4a config.toml mcp_servers 段管理
├── agents-md-installer.ts            # D1 AGENTS.md marker 注入
├── skills-installer.ts               # D2 skills 镜像
└── __tests__/
    └── toml-writer.test.ts           # A4a 13 tests

src/main/store/
├── migrations/v008_sessions_codex_sandbox.sql  # A2a
└── session-repo.ts                   # +setCodexSandbox / Row 加 codex_sandbox

src/main/adapters/types.ts            # +canRestartWithCodexSandbox capability + restartWithCodexSandbox? 接口
src/main/adapters/claude-code/sdk-bridge/sdk-message-translate.ts  # tool-use-end +status 字段 (A1)

src/renderer/
├── stores/session-store.ts           # +upsertEvent (A1 in-place upsert)
├── components/SessionDetail/ComposerSdk.tsx  # +sandbox 下拉 (A2c)
├── components/activity-feed/rows/tool-row.tsx  # +failed 红色 (A1)
└── components/settings/sections/
    ├── CodexMcpServersSection.tsx    # A4b
    └── CodexInjectionSection.tsx     # D4

src/main/cli.ts                       # A9 +--adapter / --codex-sandbox

src/shared/types/settings.ts          # 4 个新 settings 字段 + CodexMcpServerConfigShared

changelog/CHANGELOG_61.md             # R1.A 总结
changelog/CHANGELOG_62.md             # R1.D 总结
experiments/spikes/SPIKE_REPORT.md    # spike 详细报告
```

## CLAUDE.md 工程地基注意

- **每个 task 独立 commit**：用户明确选「一任务一 commit」节奏
- **巨型重构走双对抗 plan**：R3（E 阶段）必须先 spawn `reviewer-claude` + `reviewer-codex` 双 teammate 评审 E0 ADR，三态裁决后再切 PR（CLAUDE.md「决策对抗」+ plan v3 验证流程）
- **典型 worktree 流程**：每个大阶段一个 worktree → typecheck + vitest 通过 + 一任务一 commit → 阶段收口写 CHANGELOG → ExitPlanMode 由用户验证 → merge → 删 worktree
- **macOS 没有 timeout**：Bash 命令体里禁止写 `timeout 5m ...`，超时只走 Bash 工具的 timeout 参数
- **Node / pnpm 走登录式 zsh**：`zsh -i -l -c "..."` 拿 brew + nvm + path_helper 注入的 PATH

## 已确认的 plan v3 决策（不要再问）

| 决策点 | 用户拍板 |
|---|---|
| AGENTS.md 同步方向 | 单向 overwrite Agent Deck 段 |
| MCP transport | 三协议并存（in-process + HTTP + stdio） |
| E 阶段策略 | **硬切**（直接重写废弃老 backend，无双轨） |
| F Generic-PTY 优先级 | 放最后做 |
| worktree 节奏 | 隔离 + 一任务一 commit + checkpoint |

## 上一会话有未做的 codex sync 实测

dev 启动 + 实际跑 codex 会话 + 看 ~/.codex/AGENTS.md 和 ~/.codex/skills/agent-deck/ 写入
**没有在上一会话做**（避免在没用户授权下修改用户 ~/.codex 目录）。下一会话 / 用户在 merge 前
按上面验证清单实测一遍。

如果实测发现 D1/D2 行为有问题（如 marker 写错位置 / 未替换 / 用户内容被破坏），优先回滚
`f6cf0a7..785e5f5` 4 个 R1.D commit 而不是回滚整 R1（R1.A 10 commit 完全独立无 D1/D2 依赖）。
