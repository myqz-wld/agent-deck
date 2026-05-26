---
plan_id: deep-review-flow-fix-20260512
created_at: 2026-05-12
worktree_path: /Users/apple/Repository/personal/agent-deck/.claude/worktrees/deep-review-flow-fix-20260512
status: completed
base_commit: 8f4f7c70800b4daa507637de0f399d9df3de5401
completed_at: 2026-05-12
completed_phases: [A, T1, B (D1+D3), C]
followup: [B-D2 inherit_caller_permissions, B-D4 wait_reply finished/waiting-for-user 区分]
merged_commits: [9465d92, 8de8401, fe37da9, bb75050]
---

# Plan: deep-code-review 流程顺畅化 + 透明化快捷键

## 总目标 & 不变量

**目标**：把 deep-code-review 这套异构对抗 review 流程踩到的 5 类坑修顺，让本流程能稳定无人工介入跑完一轮 R1（reviewer-claude + reviewer-codex 都出 finding）。顺带加一个主窗口透明化快捷键。

**触发本 plan 的本轮铁证**（CHANGELOG_74 review 跑出的现场）：
1. **reviewer-codex teammate Bash 卡审批 1200s 后被自动拒绝**：根因 a)`mktemp` 默认 TMPDIR `/var/folders/...` 被 macOS sandbox 拦；b)`Bash(zsh:*)` 不在 reviewer-codex teammate 的 settings.json `permissions.allow` 白名单
2. **spawn_session prompt 嵌 plugin agent body 全文**（每个 reviewer 几百行）：根因 spawn_session schema 没 `agent_name` 字段，plugin agent body 不会自动注入；lead 还得 Bash find body file 路径
3. **wait_reply 在 reviewer 卡 `waiting-for-user` 时返回 `reason="turn-complete"`**：lead 拿 partial events 误以为 reviewer 完事
4. **lead `teamName: null` 不对称**：spawn 出的 reviewer teammate 都有 teamName 但 lead 自己 null；send_message 「单 team auto-resolve」逻辑可能不对 lead 生效
5. **teammate session 在主列表平铺**：与 desk-assistant 等普通用户 session 平级显示

**不变量（不能违反）**：
- 异构对抗原则：reviewer-codex 失败时**严禁降级到同源双 Claude**；但允许走「双 Bash 主路径起外部 codex CLI」（仍异构 gpt-5.5 vs Opus，是合规兜底）
- 修改后 reviewer-codex.md / reviewer-claude.md 行为反模式表 / 失败兜底表必须保持向后兼容
- 改动 `spawn_session` / `wait_reply` schema 时不能 break 现有调用方（agent_name / inherit_caller_permissions 等都是 optional）
- README 「键盘快捷键」节如已存在则同步更新；不存在则新增小节
- 主窗口透明化快捷键不能与现有快捷键冲突

---

## 设计决策（不再争论）

### D1. spawn_session 加 `agent_name?: string` 自动注入 plugin agent body
- **决定**：in-process transport 在 spawn 时若 `agent_name` 非空 → 按 agent name 在 plugin agents registry 找 body file → resolved body 作为 system prompt 一部分注入；caller 传的 `prompt` 作为「task body」追加在最后
- **不取**：把整个 body 嵌进 caller `prompt`（当前形态）—— 重复 token、需要 caller find body file
- **不取**：用 Agent tool subagent 模式（agent body 已废弃）
- **向后兼容**：未传 `agent_name` 时行为 100% 不变（prompt 直接当系统消息）

### D2. spawn_session 加 `inherit_caller_permissions?: boolean` 选项
- **决定**：true 时 in-process transport 把 caller session 的 `permissions.allow` 数组合并到新 teammate session
- **默认值**：false（保持现状，避免 caller 不知情扩散权限）
- **风险**：caller 是 lead 时如果 lead 自己有 `Bash(*:*)` 这种宽松条目会扩散给 teammate；plugin docs 要明示「只在 teammate 信任程度等同于 lead 时启用」

### D3. spawn_session in-process 把 lead 加进 team membership（修 D-1 不对称）
- **决定**：spawn_session resolve `caller_session_id` 后，把 lead session 也加入 team `members[]`；list_sessions 投影 lead `teamName` = 该 team
- **影响**：send_message 「单 team auto-resolve」能正确对 lead 生效；UI 上 lead 也带 team badge

### D4. wait_reply 区分 `finished` vs `waiting-for-user`
- **决定**：`until: 'turn_complete'` 语义收紧 = 只有真正 `finished` event 才 fire；`waiting-for-user` 单独成一个 partial 状态，超过用户配置阈值（默认 30s）时 `wait_reply` 返回 `reason: 'waiting-for-user'`（区别于 `'turn-complete'` / `'idle'` / `'first_message'` / `'timeout'`）
- **新增枚举**：`until: 'turn_complete_or_waiting'` 兼容路径，让旧调用方明确选择；旧 `'turn_complete'` 仍 fire 但**只在真 finished**
- **向后兼容**：旧 caller 用 `'turn_complete'` 时如果 reviewer 卡 waiting-for-user → 等到 timeout_ms 而不是误返回 false-positive

### D5. reviewer-codex.md agent body 加 `$TMPDIR` 强制 mktemp template
- **决定**：所有 `mktemp` 改为 `mktemp "$TMPDIR/codex_xxx.XXXXXX"`，强制走 sandbox-allowed 路径（macOS Claude Code sandbox `$TMPDIR=/tmp/claude-<uid>`）
- **影响**：reviewer-codex teammate 第一个 Bash 不会再因 `/var/folders/...` 拦截卡审批

### D6. SKILL doc 加「spawn 前权限自检」与「cold-start 卡 30s 探测」节
- **决定**：
  - Step 0 加权限自检：spawn reviewer-codex 前先 `cat ~/.claude/settings.json | jq '.permissions.allow'` 看是否含 `Bash(zsh:*)` / `Bash(zsh -i -l -c:*)` / `Bash(codex:*)`，缺则提示用户加白名单或选项 `inherit_caller_permissions: true`
  - Step 2 加 cold-start 探测：spawn 后 30s 内若 reviewer-codex 没 `tool-use-end` → 调 list_sessions 看 lifecycle / get_session 看 lastEventAt → 提示用户去 PendingTab；不傻等 1200s 自动拒绝

### D7. SKILL doc 加「双 Bash 主路径兜底」明示合规
- **决定**：失败兜底表加新行「reviewer-codex teammate 通道 Bash 权限审批失败 / cold-start stuck → lead 走 Bash run_in_background 起外部 codex CLI（仍异构）→ reviewer-claude teammate 不动 → 拿到独立 codex 结论后照常做三态裁决」
- **不变量**：仍严禁降级到「让 reviewer-claude 自己也跑一遍 codex 视角」（同源化）
- **关联**：CLAUDE.md「reviewer-codex 失败兜底」节同步明示

### D8. UI teammate session 按 spawnedBy 树形折叠
- **决定**：SessionList 渲染时如 `spawnedBy != null` 且 owner session 仍 active → 缩进显示在 owner 下；teammate 仍可点击进入并用现有 ComposerSdk 发消息
- **owner 不在了的孤儿 teammate**：仍平铺显示（不绑死 owner）

### D9. 主窗口透明化快捷键
- **决定**：macOS 用 `Cmd+Shift+T`（确认与现有快捷键不冲突）；toggle 主窗口透明状态（设置面板已有该开关，快捷键复用其状态）
- **位置**：renderer 端 keybind handler 调既有 `setTransparent` IPC（如已存在）；如未抽 IPC 则用 main 进程 globalShortcut 注册
- **README**：「键盘快捷键」节加这条
- **冲突回避**：搜现有 keybindings.json / renderer keymap 确认 `Cmd+Shift+T` 没占；占了换 `Cmd+Alt+T`

---

## 步骤 checklist

### Phase A — 纯 doc / agent body（零代码风险）

- [x] **A.1** 改 `<worktree>/resources/claude-config/agent-deck-plugin/agents/reviewer-codex.md`：所有 `mktemp` 改 `mktemp "$TMPDIR/codex_xxx.XXXXXX"`（D5）；`核心纪律` 节加一条「mktemp 必走 $TMPDIR 防 sandbox 拦」；`反模式` 表加「mktemp 默认 /var/folders/... 被沙盒拦 → 卡审批」 — done by sess-2026-05-12-接力 on 2026-05-12，commit 9465d92
- [x] **A.2** 改 `<worktree>/resources/claude-config/agent-deck-plugin/skills/deep-code-review/SKILL.md`：
  - Step 0.6 加「spawn 前权限自检」子节（D6 上半，含 jq 自检命令 + A/B/C 三选项）
  - Step 1 加 prompt 注入两种形态（当前嵌 body / B 阶段后 agent_name 自动注入）
  - Step 2.5 加「cold-start 卡 30s 探测」子节（D6 下半）
  - 「失败兜底」表加双 Bash 主路径明示（D7）
  — done by sess-2026-05-12-接力 on 2026-05-12，commit 9465d92
- [x] **A.3** 改 `<worktree>/resources/claude-config/CLAUDE.md`「决策对抗 → reviewer-codex 失败兜底」节：明示双 Bash 主路径合规（D7） — done by sess-2026-05-12-接力 on 2026-05-12，commit 9465d92
- [x] **A.4** typecheck 跑通（doc 改通常不影响，但 build 链路 sanity check） — done by sess-2026-05-12-接力 on 2026-05-12（worktree 内首次跑需先 `ln -sf <main-repo>/node_modules <worktree>/node_modules`，已建 symlink）

### Phase T1 — 透明化快捷键

- [x] **T1.1** Grep 现有「透明化」相关代码：定位 `settings.transparentWhenPinned` (boolean) + `FloatingWindow.setTransparentWhenPinned(value)` (idempotent，同 value 多调 setVibrancy 安全) + 设置面板 `WindowSection.tsx` 控件 — done by sess-2026-05-12-接力 on 2026-05-12，commit 8de8401
- [x] **T1.2** Grep 现有快捷键映射：现存 `globalShortcut.register('CommandOrControl+Alt+P', ...)` (pin)；`Cmd+Shift+T` 被浏览器「重开关闭标签页」抢（OS 级 globalShortcut 真冲突），按 D9 fallback 走 `Cmd+Alt+T`（与 `Cmd+Alt+P` 命名一致） — done by sess-2026-05-12-接力 on 2026-05-12，commit 8de8401
- [x] **T1.3** 实现：4 处镜像 PinToggled pattern — `shared/ipc-channels.ts` 加 `TransparentToggled` + `main/index.ts` step 10.5 globalShortcut.register + `preload/index.ts` 加 onTransparentToggled facade + `renderer/App.tsx` 加 useEffect 监听 — done by sess-2026-05-12-接力 on 2026-05-12，commit 8de8401
- [x] **T1.4** 改 README.md：新增「键盘快捷键」节（在「设置」与「项目结构」之间），表格列 `Cmd+Alt+P` + `Cmd+Alt+T` + 行为 + 选 Cmd+Alt 而非 Cmd+Shift 的理由 — done by sess-2026-05-12-接力 on 2026-05-12，commit 8de8401
- [x] **T1.5** 写 CHANGELOG_75.md + 同步 INDEX.md — done by sess-2026-05-12-接力 on 2026-05-12，commit 8de8401
- [ ] **T1.6** dev 实测：起 dev → 切主窗 → 按 Cmd+Alt+T → 验证主窗透明开/关 toggle — **等用户手动验证**（agent 没法按真键；改 main / preload 必须重启 dev，HMR 不够）

### Phase B — mcp tool 实现（要单元测试）

- [x] **B.1** 改 `<worktree>/src/main/agent-deck-mcp/tools.ts`（D1）：spawn_session schema 加 `agent_name?: string` (zod regex `[a-zA-Z0-9._-]+`, max 128) — done by sess-2026-05-12-接力 on 2026-05-12，commit fe37da9
- [x] **B.2** 改 in-process / HTTP / stdio handler（D1+D3）：
  - **D1**：`args.agent_name` 非空时调 `getBundledAssetContent('agent', name)` → 找不到 err（防静默 fallback 落空）→ 拼 `${body}\n\n---\n\n${args.prompt}` 注入 SDK
  - **D3**：projectSession 改成「先 `agentDeckTeamRepo.findActiveMembershipsBySession` + `get` 反查 → fallback `s.teamName`」
  - **D2 (`inherit_caller_permissions`)**：未做（follow-up，调研发现 SDK API 仅粗粒度 `allowedTools: string[]`，per-session settings overlay 超预期；user scope `~/.claude/settings.json` 已能 99% 兜底）
  - **D3 第三点 (lead 加 team membership)**：spawn_session handler 第 336-348 行**已经实现**（之前误判 plan v1）
  — done by sess-2026-05-12-接力 on 2026-05-12，commit fe37da9
- [ ] **B.3** wait_reply `until: 'turn_complete'` 收紧为只 `finished`（D4）：未做（follow-up）。当前实现包含 `waiting-for-user` 是 by-design（wait-reply-coordinator.ts:115-116）；改为只 `finished` 是 breaking change 影响 SKILL 全部调用；A.2 Step 2.5 cold-start 30s 探测已应用层兜底。
- [x] **B.4** typecheck + 5 个新增 unit test（D1 三 + D3 二）：tools.test.ts 33 tests 全过（agent-deck-mcp 全套 54 全过） — done by sess-2026-05-12-接力 on 2026-05-12，commit fe37da9
- [-] **B.5** preload + shared/types 同步：未需要（spawn_session 是 mcp 内部，不走 IPC preload；schema 加可选字段向后兼容）
- [ ] **B.6** dev 实测：spawn reviewer-codex 用 `agent_name` 自动注入 → reviewer-codex 真起 codex CLI 并出 finding；多 teammate 验 lead teamName 已显示 — **等用户手动验证**
- [x] **B.7** 写 CHANGELOG_76 + 同步 INDEX.md — done by sess-2026-05-12-接力 on 2026-05-12，commit fe37da9

### Phase C — UI（要 dev 实测）

- [x] **C.1** 改 `<worktree>/src/renderer/components/SessionList.tsx`：新增 `renderTreeGroup` helper 按 `spawnedBy` 分组到 `childrenByOwner` Map + roots[]；root 后跟 wrapper div 装 children (`ml-3 border-l border-blue-400/20 pl-2.5` 缩进)；孤儿 teammate（D8）平铺为 root — done by sess-2026-05-12-接力 on 2026-05-12，commit bb75050
- [x] **C.2** 验证 teammate 仍可点击进入 detail + 用 ComposerSdk 发消息：onSelect 透传不变，store.selectSession 流程沿用 — done by sess-2026-05-12-接力 on 2026-05-12，commit bb75050（代码 review 验证）
- [x] **C.3** 加 team 标识 visual：teammate / lead 各加 badge：SessionCard 加 `teamRole?: 'lead' | 'teammate'` prop，lead 容器加 border-blue-400/40 + 👑 lead chip，teammate 加 ↳ teammate chip — done by sess-2026-05-12-接力 on 2026-05-12，commit bb75050
- [ ] **C.4** dev 实测：起 dev → spawn 一对 reviewer → 验证树形显示；shutdown 一个 teammate → 验证树状态更新；spawn 多 team → 验证不混淆 — **等用户手动验证**（renderer HMR，无需重启 dev）

### Phase D — 收口验证

- [ ] **D.1** 整轮 deep-code-review 实跑（用本 plan 改完后的 SKILL）：随便挑一个最近 commit 走完 R1，验证 reviewer-codex teammate 真起 codex CLI 不卡审批 — 等用户手动验证（agent_name 自动注入 + lead teamName 显示 + 树形折叠 综合 dev 实测）
- [ ] **D.2** worktree branch 合回 main：`git checkout main && git merge worktree-deep-review-flow-fix-20260512` 合 4 commit (9465d92 + 8de8401 + fe37da9 + bb75050)
- [ ] **D.3** plan frontmatter 置 `status: completed`
- [ ] **D.4** `<main-repo>/changelog/CHANGELOG_75/76/77.md` + INDEX.md 已 worktree 内建好，合并后自动到 main
- [ ] **D.5** `ExitWorktree(action: "keep")` + Bash `git worktree remove .claude/worktrees/deep-review-flow-fix-20260512` + `git branch -D worktree-deep-review-flow-fix-20260512`

---

## 当前进度

- ✅ EnterWorktree 完成 → cwd `/Users/apple/Repository/personal/agent-deck/.claude/worktrees/deep-review-flow-fix-20260512`
- ✅ base_commit `8f4f7c70800b4daa507637de0f399d9df3de5401`（main HEAD = CHANGELOG_74 Step 6 docs）
- ✅ 主仓库 .claude/plans/ 目录已创建
- ✅ plan 文件落 `/Users/apple/Repository/personal/agent-deck/.claude/plans/deep-review-flow-fix-20260512.md`
- ✅ **Phase A 全完**（commit `9465d92`）：reviewer-codex.md `$TMPDIR` + SKILL.md Step 0.6/1/2.5 + resources/claude-config/CLAUDE.md 双 Bash 兜底合规
- ✅ **Phase T1.1-T1.5 完**（commit `8de8401`）：Cmd+Alt+T 透明化全局快捷键 + README 「键盘快捷键」节 + CHANGELOG_75
- ✅ **Phase B D1+D3 完**（commit `fe37da9`）：spawn_session agent_name 自动注入 plugin agent body (D1) + projectSession 反查 universal team backend lead teamName (D3) + 5 unit test + SKILL.md 同步 + CHANGELOG_76
- ✅ **Phase C 全完**（commit `bb75050`）：SessionList 按 spawnedBy 树形折叠 + SessionCard teamRole prop（lead 蓝边 + 👑 chip / teammate ↳ chip）+ CHANGELOG_77
- ⏳ **T1.6 + B.6 + C.4 + D.1 dev 实测等用户**（renderer C 走 HMR 不需要重启 dev；T1 改 main + preload 必须重启 dev）
- 🔻 **D2 inherit_caller_permissions** / **D4 wait_reply 区分 finished/waiting-for-user**：留 follow-up（详 plan §设计决策 + CHANGELOG_76 备注）
- 卡在：等用户 dev 实测 + 决定是否 cleanup 合 4 commit 回 main

---

## 下一会话第一步

**首选**：用户先做 dev 实测（T1.6 + B.6 + C.4），OK 后走 cleanup 合 4 commit 回 main。

```bash
# 1. 杀干净旧实例 + dev 实例
pkill -f "Agent Deck.app/Contents/MacOS/Agent Deck" 2>/dev/null
pkill -f "electron-vite dev" 2>/dev/null
lsof -ti:47821,5173 2>/dev/null | xargs -r kill -9

# 2. 在 worktree 内起 dev
cd /Users/apple/Repository/personal/agent-deck/.claude/worktrees/deep-review-flow-fix-20260512
zsh -i -l -c "pnpm dev"
```

dev 起来后验证 4 件事：

**T1.6 透明快捷键**：按 `Cmd+Alt+T` 切「置顶时透明」开关；pin 状态下立即看 vibrancy 切；设置面板「窗口 → 置顶时透明」开关同步切

**B.6 spawn agent_name + lead teamName**：在 dev 应用内开个 SDK 会话调 `mcp__agent_deck__spawn_session({adapter:'claude-code', cwd:'/repo', prompt:'task', agent_name:'reviewer-claude', team_name:'test', caller_session_id:<本 sid>})`；验证 spawn 成功、teammate 收到的 first prompt 含 reviewer-claude.md body 开头几行；调 `list_sessions` 看 lead 自己的 teamName 字段非 null

**C.4 树形折叠**：spawn 出的 reviewer teammate 在 SessionList 中应显示在 lead 下方（缩进 + 左侧细蓝边）；lead 容器加蓝色边框 + 👑 chip；teammate 加 ↳ chip

**D.1 完整链路**：在 dev 应用内试跑一轮 deep-code-review SKILL（如果你有 reviewer-claude/codex teammate 跑通，可证明 A+B agent_name 注入 + C 树形显示真生效）

实测都 OK 后走 cleanup（按全局 CLAUDE.md「§Step 4. plan 完成 / 中止 cleanup」）：

```bash
# 1. ExitWorktree(action: "keep") （在 worktree 内当前会话）

# 2. 主仓库 cwd 合并 worktree branch
cd /Users/apple/Repository/personal/agent-deck
git checkout main
git merge worktree-deep-review-flow-fix-20260512
# 应当无冲突合 4 commit (9465d92 + 8de8401 + fe37da9 + bb75050)

# 3. plan frontmatter 置 status: completed
# 编辑 /Users/apple/Repository/personal/agent-deck/.claude/plans/deep-review-flow-fix-20260512.md
# 把 frontmatter 里 `status: in_progress` 改为 `status: completed`

# 4. 删 worktree
git worktree remove .claude/worktrees/deep-review-flow-fix-20260512
git branch -D worktree-deep-review-flow-fix-20260512
```

**Phase D2 / D4 follow-up 候选**（任何时候用户决定要做时）：
- D2 inherit_caller_permissions：per-session settings overlay 跨 ClaudeCodeAdapter / SDK / settings 三层重改；先 spike 验 SDK API additionalPermissions 是否 supported
- D4 wait_reply 区分 finished / waiting-for-user：breaking change，需先把 SKILL.md 全部 `until: 'turn_complete'` 调用过一遍区分意图

**强约束**：所有路径用 worktree 内绝对路径（含 `.claude/worktrees/deep-review-flow-fix-20260512/` 前缀），plan 自身路径不换前缀。每完一阶段双向 git 验证（worktree dirty + 主仓库 clean）+ commit。

---

## 已知踩坑

- **plan 文件路径**：必须用 main repo 的 `.claude/plans/<plan-id>.md`（非 worktree working tree），因为 worktree 是独立 branch，跨会话主 repo 看不到 worktree 内文件
- **代码资产路径必须含 worktree 前缀**：`<worktree-abs-path>/resources/claude-config/...` 形态，**不要**写 `<main-repo>/resources/claude-config/...` —— 后者在 worktree cwd 下看似 OK 实际操作主仓库（CLAUDE.md 「worktree 路径陷阱」段反复强调）。本 plan 「下一会话第一步」节路径已用 worktree 前缀
- **Read tool conversation cache 陷阱**：跨会话第一次读本 plan 文件**严禁用 Read tool**，必须 `Bash: cat`（CLAUDE.md「cold start 第一次读 plan 必须走 Bash: cat」段）。本会话内 Write 后立即读其他文件可正常用 Read
- **typecheck binding ABI 风险**：如改动涉及 sqlite 测试相关，跑前先确认 better-sqlite3 binding 版本（CHANGELOG_42 教训）
- **worktree 没继承 node_modules**：cold start 跑 typecheck 前若 worktree 没 node_modules（`tsc: command not found`），用 `ln -sf /Users/apple/Repository/personal/agent-deck/node_modules /Users/apple/Repository/personal/agent-deck/.claude/worktrees/deep-review-flow-fix-20260512/node_modules` symlink 兜底（typecheck 纯 TS 编译不依赖 native binding 安全；如要跑 SQLite 真测则按 CHANGELOG_42 单独处理 binding ABI）
- **reviewer-codex 失败时严禁同源化降级**：Phase A.3 doc 加「双 Bash 主路径」是新合规出路，但仍**禁止**让 reviewer-claude 跑两遍补缺
- **Phase B `wait_reply` until 语义改动**：旧调用方（包括本 SKILL 自己）会受影响，B.3 必须先改 SKILL.md 同步把所有 `until: 'turn_complete'` 用法 review 一遍是否要换 `'turn_complete_or_waiting'` 兼容
- **transparent 快捷键冲突**：T1.2 必须先 grep 确认 `Cmd+Shift+T` 没占（macOS 浏览器常用「重开关闭标签页」），占了换 `Cmd+Alt+T`
- **路径前缀踩坑双向 git 验证**：每完成一个 Phase 跑 `git status` 看 worktree dirty + `git -C /Users/apple/Repository/personal/agent-deck status` 看主仓库 clean（应只 dirty `.claude/plans/deep-review-flow-fix-20260512.md` 这一份 plan 文件）
