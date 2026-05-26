# CHANGELOG_46: Team 名一致性 — 三层反向同步（fs SSOT，应用 DB 跟随）

## 概要

CHANGELOG_45 用 systemPrompt 注入「你属于 team X」让 lead 自我约束 team 名 — 实测**不靠谱**：lead 把 `team-X-test` 自动 lowercase 成 `team-x-test`，sessions.team_name DB 列与 fs `~/.claude/teams/<X>/config.json` 真值飘开，用户视角「我看 TeamHub 没我建的 team」。

**根因**：之前所有方案都假设「应用预填的 teamName 是 SSOT，强制约束 lead 听话」。**反转**：fs 才是 SSOT（lead 在会话内自由建 team），应用 DB 应跟随 fs / hook 真值。

## 设计要点

### 不要 prompt-engineering，做工程兜底

「让 LLM 听话」是脆弱的。改纯工程：在 SDK 暴露的 hook 通道 + fs 通道反向同步 lead 真用的 team 名到 DB。

### 实证 SDK Hook 通道（28 个 HOOK_EVENTS 全检）

实证后发现：

- ❌ **没有** `TeamCreated` / `TeamCreate` / `TeammateSpawned` / `TeammateCreated` 任何 create 类 hook
- ✅ **`PreToolUse` 能拦 CLI builtin 工具** `TeamCreate / TeamDelete / Teammate / SendMessage`（CLI binary strings 实证 + `hook_event_name:"PreToolUse"` 协议存在），payload 含 `tool_name + tool_input`，**最早通道**（决策瞬间）
- ✅ `TaskCreated / TaskCompleted / TeammateIdle` hook payload 含 `team_name`（补强通道，几分钟后才飞）
- ✅ chokidar fs watcher 监听 `~/.claude/teams/*/config.json` add 事件（补强通道，CLI 真写 fs 几百 ms 后）

### 三层反向同步（按时效性）

```text
NewSessionDialog（无 teamName 输入框）
  └─> createSession() → SDK spawn lead CLI（env CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1）
        └─> waitForRealSessionId = S
              └─> sessions[S].team_name = NULL（DB 暂无）

lead 在会话内自由起 team：
  └─> "spawn 两个 teammate"
        └─> CLI 决定调 TeamCreate({name:'X'}) ← 决策瞬间
              └─> emit PreToolUse hook
                    └─> POST /hook/pretooluse → maybeSyncFromPreToolUse
                          └─> teamCoordinator.sync(S, 'X', 'pretool')
                                ├─> sessionRepo.setTeamName(S, 'X')
                                └─> emit session-upserted
                                      ├─> renderer SessionCard chip 'X'
                                      ├─> TeamHub 自动出现 X
                                      └─> inbox-watcher refreshAutoSubscribe → subscribe X/inboxes/

        └─> CLI 真写 ~/.claude/teams/X/config.json
              └─> [fs watcher 补强] chokidar add → sync(S, 'X', 'fs') → 已同步幂等

        └─> teammate idle → TeammateIdle hook
              └─> [hook 补强] sync(S, 'X', 'hook') → 已同步幂等
```

### 单一收口 `sync()` 幂等

`team-coordinator.ts` 暴露唯一函数：

```ts
sync(sessionId, teamName, source: 'pretool' | 'fs' | 'hook'): void {
  const s = sessionRepo.get(sessionId);
  if (!s) return;                       // 不属于应用管理的 session
  if (s.teamName === teamName) return;  // 幂等
  sessionRepo.setTeamName(sessionId, teamName);
  emit session-upserted；                // inbox-watcher refreshAutoSubscribe 自动跟随
}
```

三个 source 走同款逻辑；`session-upserted` 触发 inbox-watcher 自动 subscribe team 的 inbox（**零额外代码**）。

### 不动 fs

保留 [team-fs.ts:1-20](../src/main/teams/team-fs.ts#L1-L20) 「应用绝对不写 ~/.claude/teams/」历史约定。team-coordinator 只**读** config.json 反查 leadSessionId，不 rename / 不 patch。

### Resume + team 不再 block

之前 sdk-bridge 对 `opts.resume + opts.teamName` 直接 throw（双道防线，怕 SDK 上游 resume + teammate 状态机崩）。新设计下 NewSessionDialog 已不传 teamName，throw 实际不会被触发。把 throw 改成 console.warn 让用户自己拍板（CLI `agent-deck new --team-name` 入口仍可能传，warn 后继续不 block）。

## 变更内容

### 新增

#### `src/main/teams/team-coordinator.ts`
- `teamCoordinator.sync(sessionId, teamName, source)` 单一收口
- `teamCoordinator.startFsWatcher()` chokidar root watcher 监听 `~/.claude/teams/*/config.json`
- `teamCoordinator.shutdown()` 进程退出 close
- `extractTeamNameFromToolInput(toolName, input)` helper：从 PreToolUse payload 抽 team 名（支持 4 种工具 + 多种字段名容错）

#### `src/main/teams/__tests__/team-coordinator.test.ts`
- 31 cases vitest：sync 三态（不存在 / 幂等 / 真写）+ 三个 source 路径 + extractTeamNameFromToolInput 4 种工具 × 多种字段名命中 / 容错（不命中 / 类型错 / 空字符串）

### 修改

#### `src/main/adapters/claude-code/hook-routes.ts`
- `maybeSyncFromPreToolUse(body)` helper：PreToolUse handler 内拦 team 工具调用
- `maybeSyncFromTeamHook(body)` helper：TaskCreated/TaskCompleted/TeammateIdle handler 内反向同步
- 4 个端点 handler 各加一行调用

#### `src/main/index.ts`
- import `teamCoordinator`
- bootstrap 末尾调 `teamCoordinator.startFsWatcher()`
- before-quit 加 `teamCoordinator.shutdown()`

#### `src/main/ipc.ts:447-462`
- `AdapterCreateSession` handler：`recordCreatedTeamName` 仅在 CLI 入口显式传 teamName 时才调（NewSessionDialog 不传，team-coordinator 反向同步去写）

#### `src/main/adapters/claude-code/sdk-bridge.ts`
- env 注入 `CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1` 条件改成「只看 `agentTeamsEnabled` 设置」（不再要求 opts.teamName 非空）
- task-mcp closure team_name 改 lazy 工厂 `() => sessionRepo.get(sid)?.teamName ?? null`
- resume + teamName throw 改 console.warn（不再 block）
- 撤回 systemPrompt.append 注入 team 元信息（CHANGELOG_45 后续追加节加的，已撤）

#### `src/main/task-manager/server.ts`
- `getTasksMcpServerForSession(teamNameProvider)` 第二参数从 `string | null` 改 `() => string | null`

#### `src/main/task-manager/tools.ts`
- `buildTaskTools(repo, teamNameProvider)` 第二参数改 lazy
- 5 个 tool handler 内部用 `getTeamName()` 工厂调用替代之前的 closure 固定值
- description 字符串改通用措辞（不再嵌具体 team 名 — 描述构造时固化无法动态嵌）

#### `src/main/task-manager/__tests__/tools.test.ts`
- `buildToolsAsDict` helper 把 fixed teamName 包成工厂兼容新签名
- 24 cases 行为不变全通

#### `src/renderer/components/NewSessionDialog.tsx`
- 删 `teamName` state + 输入框 + `canJoinTeam` 联动
- 删 `lastInjectedTemplateRef` + `makeTeamPromptTemplate` + 自动回填逻辑
- 删 `TEAM_NAME_PATTERN` 校验
- 加 `showTeamHint` 文案（`agentTeamsEnabled` 开 + adapter `canJoinTeam` 时显示「team 名由 lead 在会话内自由决定」提示）

#### `src/main/teams/team-coordinator.ts` JSDoc 修复
- 之前注释里 `\`~/.claude/teams/*/config.json\`` 含 `*/` 提前关闭多行注释，TS 解析后面全错；改成 `<X>` 占位

### 不动

- `team-fs.ts` 「应用绝对不写」约定保留
- `team-watcher.ts` per-team watcher（TeamDetail 用）不动
- `inbox-watcher.ts` 不动（refreshAutoSubscribe 自然跟随 sessions.team_name 变化）
- SKILL.md 不动（已是干净基线）
- `hook-installer.ts` 不动（PreToolUse 已注入 9 个 hook 内）
- `sessionManager.recordCreatedTeamName` 保留（CLI `agent-deck new --team-name` 兼容）

## 不做的事 / Follow-up

### Teammate 探活 + 自动重启（用户提到）

> teammate 怎么算死，不能探活重启吗？

理论上能做。可探活信号：
- `~/.claude/teams/<X>/config.json` members 数组的 sessionId 对应的 SDK 子进程是否在
- `~/.claude/teams/<X>/inboxes/<member>.json` mtime / 长时间无 reply
- TeammateIdle hook 飞的频率（idle 不一定是死，但长时间无任何 hook 飞 = 可能死了）
- PreToolUse SendMessage 拦截前查 target teammate 是否在 members + 是否 alive

**本 PR 不做**，独立 follow-up PR。原因：
- 探活语义模糊：teammate idle != dead；teammate "正常等" 与 "已 cleanup" 应用层难分
- 自动重启策略复杂：lead 上下文里仍引用旧 teammate id，重启后 id 变了 lead sendMessage 找不到
- 上游 SDK 实验特性的 teammate lifecycle 协议还在演进，自动恢复机制等 Anthropic 上游补 ResumedTeammate / ReconnectTeammate 类 hook 后做最稳

短期 workaround：用户在 TeamDetail UI 看到 teammate 长时间 idle 后手动 `force-cleanup` + 让 lead 重新 spawn。

### in-process MCP 替换 CLI 内置 team 工具（用户提议）

> 需要的但是没有的，全部替换为自己的 mcp 实现，就跟 task created 一样

更激进方案：disallowedTools 屏蔽 CLI 内置 `TeamCreate / TeamDelete / Teammate / SendMessage`，应用暴露同款 in-process MCP 工具完全接管 team 协议层。**未做**，需先 spike 验证「屏蔽后 in-process backend 是否还能正常运转」（可能 backend 内部强依赖这些 builtin）。

## 验证

```bash
zsh -i -l -c "pnpm typecheck"   # ✅
zsh -i -l -c "pnpm test"        # ✅ 151 passed | 23 skipped (174)
zsh -i -l -c "pnpm build"       # ✅
```

实测路径（重启 dev 后跑）：

1. 设置开 `agentTeamsEnabled` + 已 `hook:install`
2. 新建 SDK 会话（**无 teamName 输入框**）— 提示「Agent Teams 实验特性已启用，team 名由 lead 在会话内自由决定」
3. prompt: `跑 /agent-deck:deep-code-review 评审最新 commit。Round 1 跑完就停。`
4. lead 自由起 team（自创 / hash / 任意名）
5. 期望（按时效顺序）：
   - **PreToolUse 拦截**（决策瞬间）：dev 终端 `[team-coordinator] sync from pretool: session=S team=<X> (was: null)`
   - fs add（几百 ms 后）：`sync from fs: ... → 幂等 no-op`
   - TeammateIdle hook（几分钟后）：`sync from hook: ... → 幂等 no-op`
6. 一致性验证：
   - `sqlite3 sessions.db "SELECT team_name FROM sessions WHERE id='<S>'"` = `<X>`
   - TeamHub 自动出现 `<X>` 与 fs 完全一致
   - PendingTab 弹审批 chip 显示 `reviewer-codex @ <X>`

> **首次跑必看**：dev 终端 `[team-coordinator] sync from pretool: session=... team=<X>` log 里 `<X>` 字段名实证（CLI `tool_input` 实际用 `name` / `team_name` / `teamName` / `team` 哪个键）。helper 现在同时尝试这几个键命中即可，但首次跑应记录命中的具体键名供后续调优。

## 关联

- 上游 team 机制：[CHANGELOG_35](CHANGELOG_35.md)（M1 sessions.team_name + UI）/ [CHANGELOG_39](CHANGELOG_39.md)（M2 fs 视图）/ [CHANGELOG_40](CHANGELOG_40.md)（M3 hook event 已挂三个端点）
- 上游 inbox watcher（refreshAutoSubscribe 自然跟随）：[CHANGELOG_45](CHANGELOG_45.md)
- 撤回的失败尝试（CHANGELOG_45 内）：extraArgs `--team-name` flag、SKILL.md「先 ls 检查」、systemPrompt 注入 team 元信息

## 双对抗 review 历程（裁决记录）

- **reviewer-claude (Opus 4.7 xhigh Explore)**：B + D（chokidar root watcher + SessionStart hook 兜底），前提 DB SSOT 强制 fs rename
- **reviewer-codex (gpt-5.5 xhigh)**：B + D-lite（同上），前提同样
- **用户反转 1**：fs SSOT，应用 DB 跟随
- **用户反转 2**：先实证有没有 team create / teammate create 事件
- **用户反转 3**：需要的但是没有的，全部替换为自己的 MCP 实现
- **用户反转 4**：teammate 探活 + 自动重启
- **实证最终结论**：
  - HOOK_EVENTS 28 个全列：**没有 create 类 hook**
  - **CLI 内置工具 `TeamCreate / TeamDelete / Teammate / SendMessage` 是 PreToolUse 能拦的 builtin**（最早通道）
  - SDK hook 通道（TeammateIdle / TaskCreated / TaskCompleted）作补强
  - fs add 作补强
- **方案 = 三层反向同步**（PreToolUse 主 + fs / hook 补强）单一收口 `sync()`，幂等
- **进阶（用户提议）**：探活重启 + in-process MCP 替换 CLI builtin → 各自独立 PR，需 spike

plan 文件：`/Users/apple/.claude/plans/indexed-leaping-gizmo.md`
