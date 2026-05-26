---
plan_id: "reviewer-codex-cross-adapter-20260519"
created_at: "2026-05-19"
worktree_path: "/Users/apple/Repository/personal/agent-deck/.claude/worktrees/reviewer-codex-cross-adapter-20260519"
status: "completed"
base_commit: "40d7527dbbc410eb04d1ddeabd999f45c87b0a0c"
base_branch: "main"
final_commit: "1bc754cf34bf2ac66f3bf8b441d48bd6afb98bf6"
completed_at: "2026-05-20"
---
# reviewer-codex 跨 adapter 直起 + codex 端 deep-review 落地

## 总目标

让 deep-review SKILL 的「异构对偶 reviewer」编排在**双向 lead × adapter 矩阵下都能用 native 形态**（删除现存 2 份 wrapper agent body），同时让 codex CLI 用户也能 `/agent-deck:deep-review` 触发同款编排。

## 不变量

1. **cross-adapter teammate 上行 dispatch 必须 work**：reviewer-codex（codex-cli adapter）调 `mcp__agent-deck__send_message` 时 reply 应通过 universal-message-watcher 自动注入 lead conversation flow，**无 manual 转贴**。spike 1+2 实测当前 broken（必修 Phase 0 prerequisite）
2. **同源化禁令物理保证**：异构对偶两 reviewer 必须分别跑在两个不同 adapter 的 SDK 子会话（claude SDK + codex SDK），杜绝 wrapper 跨 SDK 拼合的中间形态污染
3. **lead adapter 任意性**：无论 lead 是 claude-code 还是 codex-cli adapter，SKILL.md 编排都起 native reviewer-claude（claude-code adapter）+ native reviewer-codex（codex-cli adapter）一对，不因 lead adapter 差异而退回 wrapper
4. **SSOT 单写多 build**：deep-review / hello-from-deck SKILL.md 内容**仓库里维护单份**（在 `resources/claude-config/agent-deck-plugin/skills/`）；codex-config 端通过 build-time auto cp 拿到一份镜像。skills-installer 把 SKILL.md 镜像到 `~/.codex/skills/agent-deck/<X>/SKILL.md` 让 codex CLI 加载（已 spike 4 实证 work）
5. **资产面板视觉**：同 name 同 kind 跨 adapter 资产 UI 合并为单条 + 双 adapter 双角标（节省视觉空间 + 表达「SSOT 同一份内容、两端均可用」）。改造后 agents 不再同 name 跨 adapter（reviewer-{claude,codex} 各只剩 1 份 native），双角标视觉**仅适用 SKILL**
6. **设置面板**：本次改造不动 settings 字段；spawn cross-adapter reviewer 时 codex SDK sandbox/approval 用 options-builder reviewer-* 默认（与现状一致）

## 自主推进授权（2026-05-19，user 离开期间）

user 显式授权我（lead claude SDK session）在本会话期间**自主推进 plan**，不需逐步征求确认；user 离开期间**自己决定 hand-off 时机**（按 user CLAUDE.md §Step 2.5 何时主动 hand-off 自检触发信号 + 前置条件，自然推进时主动 hand-off 起新会话）。

适用范围：
- 所有 Phase 0-6 实施步骤可自主推进；遇到不确定 design / 关键决策点时倾向「自己判断 + 落记录到 plan §设计决策」而非阻塞等 user
- hand-off 触发：完成独立 phase（如 Phase 0 closeout）/ context 渐满 / 单次 turn 内做完不下了 → 走 user CLAUDE.md §Step 3 §选项 B 自动 hand_off_session 起新会话；新会话按 §下一会话第一步 cold-start 接力
- **例外**（仍需 user 协助 — 不阻塞但落记录到 plan §当前进度 等 user 回来处理）：
  - Phase 5 Step 5.3 codex CLI interactive 实测必须 user 在 terminal 跑，不能 agent 跨进程跑（spike 4 同款约束）
  - 用户 OAuth / 真实环境 token 等敏感操作
  - 不可逆决策（如 plan §RFC 决策 重大方向变更）

约束：进度 / 决策每步 commit 时写入 plan / spike-reports，让 user 回来后 cat 文件能看完整脉络。

## RFC 决策（不再争论）

### 改造策略

- **直接替换 wrapper，全改 native**（RFC 第 1 轮 Q1）— 删 `resources/claude-config/agent-deck-plugin/agents/reviewer-codex.md`（claude SDK wrapper）+ `resources/codex-config/agent-deck-plugin/agents/reviewer-claude.md`（codex SDK wrapper）
- **不并存 / 不留软开关**（user CLAUDE.md §提示词资产维护 约束 2「不写兼容预测」一致）
- **改造**真实定义：不是「reviewer-codex 从 wrapper 改 native」（这两形态本就共存），而是「让 SKILL.md Step 1 lead **跨 adapter** spawn 走 native，废弃 wrapper 路径」

### spike 前置策略

- **先 4 件 spike 再立 plan**（RFC 第 1 轮 Q2 + 第 2 轮 Q1）— spike 1+2 cross-adapter teammate 通信 / spike 3 codex SDK dormant resume audit / spike 4 codex CLI 加载 SKILL
- spike 已收尾，结论 inline 进 §spike 实证 节

### codex 端 SKILL 物理位置

- **build-time auto cp**（RFC 第 2 轮 Q2 + plan review R1 §M3 修订敲单一策略）— 把 `resources/claude-config/agent-deck-plugin/skills/` 内容物 cp 到 `resources/codex-config/agent-deck-plugin/skills/`；**纯 build-time cp 单一策略**，不走 dev mode symlink alt（macOS BSD `cp -R src/ symlink-dir/` 写穿 source 风险）。bundled-assets.ts dual-root scan 自然找到，资产面板两端均展示

### 资产面板视觉

- **合并为单条双角标**（RFC 第 2 轮 Q3） — 改造后**仅适用 SKILL**（agents 改造后不再同 name 跨 adapter）
- **「查看完整内容」按钮形态 = 单按钮 + modal 内 [claude]/[codex] tab 切换**（plan review R1 §M4 + RFC 第 3 轮敲定）

### 设置面板

- **不动**（RFC 第 2 轮 Q4）— spawn cross-adapter reviewer 时 sandbox/approval 用现有 options-builder default，无需 settings 抽象

### 范围打包

- **一个 plan 一起做**（RFC 第 1 轮 Q3） — Phase 0-6 串行；包含 reviewer-codex 跨 adapter / codex 端 SKILL 打包 / 资产面板调整

## spike 实证

详细报告：`reviewer-codex-cross-adapter-20260519/spike-reports/spike{1+2,3,4}-*.md`

### spike 1+2 — cross-adapter teammate spawn + 通信

- ✅ **spawn 链 work**：`spawn_session(adapter:'codex-cli', agent_name:'reviewer-codex', team_name:..., cwd:...)` 返回有效 sessionId（UUID v7 = codex thread id 形式，说明 sdk-bridge sid rename 链 fire）
- ✅ **reviewer-codex 跑 review + 产出 finding**：codex SDK in-process 工作模式 work，产出独立 finding（除零未校验 MED）
- ❌ **teammate→lead 上行 send_message dispatch BLOCKER**：reviewer-codex 调 `mcp__agent-deck__send_message` 失败，reply 未自动注入 lead conversation flow。user UI tool call 显示 2 次 send_message 调用都标「失败」，reviewer-codex fallback 自己 assistant output 写「调用被取消，未能回传 lead」+ inline 给 finding；user 手工转贴给 lead

**已排除 failure 模式**：codex approvalPolicy=`'never'`（不弹审批）/ reviewer 自己 abort（reviewer 真的调出去了）/ spawn 时 token 注入失败（rename 链 fire）/ hand-off context 注入失败（screenshot 注入完整）

**未排除 failure 模式**：send_message handler 内部 9 种 err 路径之一 / transport-http auth 反查 fallbackToGlobal → external caller deny / universal-message-watcher.enqueueAgentDeckMessage 内部失败 / codex SDK 内部解读 mcp tool call cancelled。**需 Phase 0 真起 SDK pair test 复现 → 4 层 signal 定位 → fix**

### spike 3 — codex SDK dormant thread resume

- ✅ audit PASS：`codex-cli/sdk-bridge/recoverer.ts` (~280 LOC 镜像 claude 612 LOC 精简版) + jsonl 预检（`defaultCodexResumeJsonlExists` 扫 `~/.codex/sessions/<YYYY>/<MM>/<DD>/rollout-<TS>-<thread_id>.jsonl`）+ resumeThread 链完整；CHANGELOG_26/28/31 production 覆盖
- dormant reviewer-codex 唤醒 = SDK resume 复原对话 = 不触发 ⚠ FRESH SESSION warn（与 claude 端 reviewer-claude dormant 唤醒同款语义）

### spike 4 — codex CLI 加载 SKILL

- ✅ fs check PASS：`~/.codex/skills/agent-deck/{deep-review,hello-from-deck}/SKILL.md` 同步成功（skills-installer.ts work）
- ✅ user 实测铁证 PASS：user 在 codex CLI interactive 输 `/hello-from-deck` → codex 自动识别 SKILL → cat SKILL.md + 按指引跑 pwd+date + 正确响应（screenshot 21:36:38-21:37:03）
- 实证 codex CLI 自动 detect 嵌套命名空间 `~/.codex/skills/agent-deck/<X>/` + slash command explicit invocation 路径 work + SKILL.md frontmatter 兼容
- `~/.codex` 与 `~/.codex-default` 是 inode 同一（user alt home 配置），不影响 SKILL 加载结论

## 已知踩坑 / 风险

1. **Phase 0 dispatch blocker fix 不确定走哪条**：未排除模式 4 种，需 test 复现 + 4 层 signal 独立断言定位才能选 fix 路径。若涉及 transport-http auth 反查问题，可能要改 `HookServer.checkMcpAuth` / `mcpSessionTokenMap` 实现，**属高风险面（影响所有 codex SDK teammate caller_session_id 反查）**。Phase 0 Step 0.6 加 same-adapter backward compat regression（claude lead × claude reviewer-claude / codex lead × codex reviewer-codex）确保 fix 不回归同 adapter 路径
2. **wrapper 删除后历史 dormant wrapper session 兼容**：当前 active session 若是 wrapper 形态起的 reviewer-codex（claude-code adapter）— 删 agent body 不影响 active session 运行（agent body 是 spawn-time 注入，已起 session 不重读），但 dormant session 被唤醒后会触发 ⚠ FRESH SESSION warn（jsonl 在但 agent body 已变）+ 行为不可预期 → **见 Phase 2 Step 2.5 cleanup 收口操作**
3. **codex-config 端 reviewer-claude.md 删后**：codex lead spawn reviewer-claude 应改走 `spawn_session(adapter:'claude-code', agent_name:'reviewer-claude')`（cross-adapter）— 这条 path 与 spike 1+2 对偶，**也受 dispatch blocker 影响**（双向都 broken）。Phase 0 修完 dispatch + Phase 0 Step 0.5 双向 cross-adapter 都验过才进 Phase 1
4. **资产面板单条双角标渲染**：bundled-assets dual-root scan 当前对同 name 同 kind 是「不去重 + adapter 字段区分」，UI 当前是双条平铺；改单条双角标需改 `AssetsLibraryDialog.tsx` 渲染逻辑（group by name+kind, dedup, render dual-adapter badge）+ ContentViewerModal 加 [claude]/[codex] tab + adapter narrowing 字段保留（防未来 SKILL 内容跨 adapter 分叉）
5. **codex SDK approvalPolicy 'never' 物理保证**：spike 1+2 已排除「PendingTab 弹审批被 deny」failure 模式，但 plan 实施期 cross-adapter 路径下需复核 codex SDK 内部是否真的把 mcp tool call 当 tool call 处理（而非作为 user 拒绝信号上报「cancelled」）— 与 Phase 0 dispatch blocker 定位耦合，由 Phase 0 Step 0.1b signal 4 验证
6. **Phase 5 cross-adapter 反驳轮闭环**：spike 1+2 只跑了 Round 1 review，没跑反驳轮（反驳轮 lead 把 A 的 finding `send_message` 给 B 反驳）；Phase 5 Step 5.1 拆 sub-step 让反驳轮 dispatch 失败信号独立暴露不被「闭环失败」吞掉

## Phase 分解 / 步骤 checklist

### Phase 0 — 修 cross-adapter send_message dispatch BLOCKER（hard prerequisite）

**plan review R1 共识修订**：reproducer 必须**真起 cross-adapter SDK pair**（claude SDK lead + codex SDK reviewer-codex 真进程）走真实 mcp HTTP transport，**禁止 in-process mock 直调 handler 入口**。in-process mock 直调完全绕过 transport-http auth 层（withMcpGuard / EXTERNAL_CALLER_ALLOWED）+ 跳过 universal-message-watcher 异步 dispatch 步骤 + 无法 detect codex SDK 进程内部 mcp client 解读 tool result 状态。

- [ ] **Step 0.1a** 写 reproducer 框架（真起 SDK pair 而非 mock）
  - 真 spawn 一对 cross-adapter teammate（claude-code lead + codex-cli reviewer-codex 真 SDK 子进程）走真实 mcp HTTP `/mcp` route
  - 测试文件位置：`src/main/agent-deck-mcp/__tests__/send-message-cross-adapter-dispatch.test.ts`（integration test，不是 unit test）
  - 初轮 caller_session_id 走真 token map allocate（与 production 路径一致）
- [ ] **Step 0.1b** 4 层独立断言 — 任一层失败信号独立暴露不被「闭环失败」吞掉
  - **signal 1（transport-http auth 层）**：`HookServer.checkMcpAuth` → `mcpSessionTokenMap.get` reverse lookup 命中 vs fallbackToGlobal 走 sentinel；assert `req.auth.resolvedSid === reviewer-codex sessionId` 而非 sentinel；assert `withMcpGuard` 不返 `EXTERNAL_CALLER_ALLOWED.send_message=false` deny
  - **signal 2（handler 层）**：assert handler 不返 9 种 err 路径之一（`session not found / closed / self / no-shared-team / team-not-shared / ambiguous-team / reply_to_message_id not found / cross-team reply / Per-team rate limit`）；happy path assert handler 返 `queued: true` + 写入 messages 表
  - **signal 3（universal-message-watcher 层）**：assert watcher 异步 watch DB messages 表新行 → emit dispatch event → `adapter.receiveTeammateMessage` 被调用 + `adapter.sendMessage` 喂给 receiver SDK；任一异步步骤失败 emit 信号
  - **signal 4（codex SDK process 内部）**：assert codex SDK 收到 mcp HTTP response 后 tool result 是 `ok` 而非 `cancelled / error`（codex SDK 端 hook tool call result event 或 stdout 解析）
- [ ] **Step 0.2** 根据 4 层 signal 输出**精确**定位 root cause（哪一层 fail）
- [ ] **Step 0.3** 实施 fix（位置取决于 root cause；改 handler / token map / transport-http auth / universal-message-watcher / codex SDK 接入层之一）
- [ ] **Step 0.4** test 转 fix-verification（确认 happy path 4 层 signal 全 pass + reply 注入 lead conversation flow as user-role message）
- [ ] **Step 0.5** **双向 cross-adapter spawn pair + send_message 闭环回归**（plan review R1 §L2 修订：claude lead × codex teammate 与 codex lead × claude teammate **两个方向**都跑过 — Phase 0 收口必须双向都通）
  - 方向 A：claude SDK lead × codex-cli reviewer-codex（spike 1+2 实操路径）
  - 方向 B：codex-cli lead × claude-code reviewer-claude（spike 阶段未实证，本 step 首次实证）
- [ ] **Step 0.6** **same-adapter backward compat 回归**（plan review R1 §M2 修订：fix 涉及 transport-http auth / mcpSessionTokenMap 时影响所有 codex SDK teammate caller_session_id 反查 — same-adapter 路径有可能跟着回归）
  - 回归 1：claude lead × claude reviewer-claude（同 adapter teammate）send_message 双向 dispatch
  - 回归 2：codex lead × codex reviewer-codex（同 adapter teammate）send_message 双向 dispatch

### Phase 1 — 改 SKILL.md Step 1 跨 adapter spawn 编排

- [ ] **Step 1.1** 改 `resources/claude-config/agent-deck-plugin/skills/deep-review/SKILL.md` §异构对抗 表 + Step 1 spawn args
  - 行 70-76 表格中 reviewer-codex 列「claude-code adapter wrapper，内部 Bash 跑外部 codex CLI」改为「codex-cli adapter 直起 codex SDK，gpt-5.5」
  - 行 116 Step 1 spawn args 中 reviewer-codex 的 `adapter:'claude-code'` 改为 `adapter:'codex-cli'`
- [ ] **Step 1.2** 改对偶节点（如有 lead 视角描述 wrapper 形态的文本一并改）
- [ ] **Step 1.3** 改 §失败兜底 表第 1 行（reviewer-codex 失败模板，plan review R1 §L4 修订）
  - 删 wrapper 专属语义（「CLI 不可用」/「Bash 卡审批被拒」 — wrapper 删后无 Bash 中间层）
  - 改 native codex SDK 失败语义：`shell sandbox 拒 / OAuth 过期 / shell tool call timeout / codex thread jsonl 缺失走 fallback`
  - 同步 reviewer-codex.md（codex-config 端 native）的 §失败兜底 表（确保 wording 一致）
- [ ] **Step 1.4** 改 §与决策对抗节的关系 节末尾 callout `~/.claude/templates/reviewer-{claude,codex}.sh.tmpl` 关系描述（保持 user 全局模板独立性表述不变）

### Phase 2 — 删 2 份 wrapper agent body + cleanup 历史 dormant wrapper session

- [ ] **Step 2.1** 删 `resources/claude-config/agent-deck-plugin/agents/reviewer-codex.md`（wrapper：claude SDK + Bash 起外部 codex CLI）
- [ ] **Step 2.2** 删 `resources/codex-config/agent-deck-plugin/agents/reviewer-claude.md`（wrapper：codex SDK + shell 起外部 claude -p）
- [ ] **Step 2.3** 复核 `reviewer-claude.md`（claude-config 端 native）+ `reviewer-codex.md`（codex-config 端 native）frontmatter description / 架构对偶描述
  - reviewer-codex.md（codex-config 端）现行 description「与 reviewer-claude（codex 视角 wrapper：codex spawn codex 子 + Bash 起外部 claude -p）」改为「与 reviewer-claude（claude-code adapter 直起 claude SDK）」
  - reviewer-claude.md（claude-config 端）类似描述对应改
- [ ] **Step 2.4** 删 reviewer-claude wrapper 路径专用 default 注入（plan review R1 §M5 修订：真位置在 `src/main/adapters/options-builder.ts:182-185`，不是 sdk-bridge/index.ts；sdk-bridge 仅透传 envOverrideExtra）
  - 删 `options-builder.ts:182-185` 的 `if (raw.agentName === 'reviewer-claude')` 分支注入 `envOverrideExtra: { AGENT_DECK_CLAUDE_PATH: claudePath }`
  - 删 `src/main/adapters/claude-code/resolve-bundled-claude.ts`（wrapper 删后 `resolveBundledClaudeBinary()` 应无 production caller — 先 grep `rg "resolveBundledClaudeBinary"` 验证 0 caller 再删整文件）
  - 改 `src/main/agent-deck-mcp/tools/handlers/spawn.ts:261` 注释引用 `envOverrideExtra: AGENT_DECK_CLAUDE_PATH`（grep 命中点改/删注释）
  - 删 `teammate-spawn-defaults.test.ts` TC9（`agentName='reviewer-claude'` on codex-cli wrapper）+ TC11（reviewer-claude resolveBundledClaudeBinary 返 null 不注入）2 个测试；保留 TC8（reviewer-codex on codex-cli native）/ TC10 / TC10b / TC11b
- [ ] **Step 2.5** **cleanup 历史 dormant wrapper session**（plan review R1 §M1 + §L3 修订）
  - 触发条件：删 wrapper agent body 后，DB sessions 表里 lifecycle='dormant' 且 spawn 时 `agent_name='reviewer-codex' on adapter='claude-code'`（旧 wrapper 形态）/ `agent_name='reviewer-claude' on adapter='codex-cli'`（旧 wrapper 形态）的 session 仍在 — 唤醒后 jsonl 在 + agent body 已变 → fresh-session 自检不准 + 行为不可预期
  - 操作：调 `mcp__agent-deck__list_sessions({status_filter:'dormant'})` 找上述 wrapper session 列表 → 单批 `mcp__agent-deck__shutdown_session({session_id, reason:'wrapper agent body 已删除'})` 收口
  - 失败兜底：list 走不通（DB locked）/ shutdown 单条失败 → warn + hint 提示 user UI 手工到 SessionList 删 dormant wrapper session

### Phase 3 — codex-config 端 build-time auto cp SKILL

- [ ] **Step 3.1** 改 build-time 脚本加 cp step（plan review R1 §M3 修订：敲定**单一策略 = 纯 build-time cp**，删 dev symlink alt 避免 macOS BSD cp 写穿 source 风险）
  - 找现有打包脚本（`package.json` scripts / `electron-builder.config.cjs` / `prebuild` hook 等）
  - 加 cp step：`cp -R resources/claude-config/agent-deck-plugin/skills/. resources/codex-config/agent-deck-plugin/skills/`（trailing `/.` 拷贝内容物 + 强制覆盖目标 dir）
  - dev mode 也跑同步 cp（每次 build / dev start 重 cp）— 不依赖 dev/prod 模式分支 + dev 模式增量 cp 性能不是 bottleneck
  - **不**走 symlink alt（macOS BSD `cp -R src/ symlink-dir/` 会写穿 source 污染）
- [ ] **Step 3.2** 确认 bundled-assets.ts dual-root scan 自然找到（`scanSkills(codexRoot)` 不再返空数组，资产面板两端均展示）
- [ ] **Step 3.3** **新增 .gitignore entry**（plan review R1 §I1 修订：当前 `.gitignore` 无 `resources/codex-config/agent-deck-plugin/skills/` entry — 不能假设「自动忽略」）
  - 在仓库根 `.gitignore` 加：`resources/codex-config/agent-deck-plugin/skills/`（cp 产物不入 git，仍单 SSOT 在 claude-config）
  - 验证：`git status` 在 build/dev 跑完后 codex-config/skills/ 不出现在 untracked 列表
- [ ] **Step 3.4** 注意：skills-installer.ts 现在源是 `getBuiltinSkillsSourceDir()` = `resources/claude-config/agent-deck-plugin/skills/`（hardcoded claude-config）— 这条 SSOT **保持不变**（仍单源），skills-installer 把 SKILL 镜像到 `~/.codex/skills/agent-deck/` 让 codex CLI 加载

### Phase 4 — 资产面板视觉调整（单条双角标限 SKILL）

- [x] **Step 4.0** UI design 决策（plan review R1 §M4 + RFC 第 3 轮敲定）
  - **选定方案**：同一行**单**「查看完整内容」按钮 → 点击弹 ContentViewerModal → modal 内上方有 `[claude]` / `[codex]` tab，default 选 [claude] tab；点哪个 tab fetch 哪个 adapter root 的内容显示
  - 优点：列表项点击法与 single-adapter 资产一致（单点击）；UI 一致性高；双版本切换为 modal 内 tab
  - 不选「双查看按钮 [claude 版]/[codex 版]」（同一行两按钮与 single-adapter 资产 UI 不一致）
  - 不选「单按钮单 modal 不分 tab」（违反 user CLAUDE.md「不写预测未来」— 现 SSOT 同款但未来 SKILL 内容跨 adapter 分叉时无 tab 路径）
- [x] **Step 4.1** 改 `src/renderer/components/AssetsLibraryDialog.tsx` 渲染逻辑 (commit `48141ec`)
  - bundled SKILL list 渲染前按 (kind+name) group by → 同 name 同 kind 跨 adapter 合并为单条 + 双 adapter 双角标显示
  - bundled Agent list 不变（改造后 agents 不再同 name 跨 adapter，每个 agent 自然单条单角标）
  - 抽 AssetCard / AdapterBadge / dedupBundledByName 到 `assets/AssetCard.tsx` (538 行突破阈值后按项目 CLAUDE.md 单文件 ≤500 行护栏 选 1 抽子组件,主文件回 420 行)
- [x] **Step 4.2** 改「查看完整内容」按钮 + ContentViewerModal 加 adapter tab 切换 (commit `48141ec`)
  - 单按钮点击：弹 ContentViewerModal，default 选中 [claude] tab fetch claude root 内容
  - tab 切换 [codex] → fetch codex root 内容（保留 adapter narrowing 字段；改造后两 root SKILL 内容相同，但保留字段防未来分叉）
  - tab 切换走 seq guard（防 closure 捕获 stale tab，与 viewerSeqRef 同款套路）
- [x] **Step 4.3** 验证 Agents tab 视觉无副作用（mental simulate PASS — 改造后 reviewer-claude / reviewer-codex 不同 name 各形成 1-element group,AssetCard `assets.length === 1` 不进角标分支显示等价旧 UI)。**真实视觉验证待 user 重启 dev mode**(详 §当前进度 v6 节末)

### Phase 5 — 端到端回归

- [x] **Step 5.1** claude lead 跨 adapter spawn reviewer-codex 端到端 (Phase 0 Step 0.5 方向 A 实测 PASS + Phase 5 重 spawn fresh review commit `48141ec` Phase 4 改动后,reviewer-codex sessionId `019e41c8` 反馈 1 MED + 1 LOW + 1 INFO 全 ✅ 真问题,fix commit `313e1f7` close invalidate / catch reject / NonEmptyAssetGroup,reply chain 三段闭环 PASS)
  - **Step 5.1.1** cross-adapter spawn + Round 1 review 闭环 ✅
  - **Step 5.1.2** 反驳轮: skip — Step 5.1 reviewer-codex 单方提出 finding 全 LOW/MED/INFO 现场验证清晰 + reviewer 确认无异议,无需起反驳轮(三态裁决 §决策对抗 反驳轮触发条件: 单方 HIGH 才 spawn 对方 reviewer 反驳)
  - **Step 5.1.3** Round 2 review 验证 fix: skip — fix 改动 trivial defensive,reviewer-codex 已 shutdown,Step 5.2 反向 reviewer-claude INFO 复盘 Step 5.1 fix PASS 已等价 Round 2 验证
- [x] **Step 5.2** codex lead 跨 adapter spawn reviewer-claude 端到端 (Phase 0 Step 0.5 方向 B 实测 PASS + Phase 5 重 spawn,codex temp lead `019e41cd` × reviewer-claude `e7633fc1` direction-B team,reviewer-claude 反馈 0 HIGH + 0 MED + 3 LOW + 1 INFO,2 LOW defensive fix commit `1bc754c` key 加 idx + dedupBundledByName invariant 注释,1 LOW *未验证* 自降级 ❓ 不修,1 INFO 复盘 Step 5.1 fix PASS,reply chain 三段闭环 PASS)
- [ ] **Step 5.3** codex CLI interactive `/agent-deck:deep-review` 触发回归 — **委托 user 实操验证**(agent 跨进程跑不了 interactive shell,按 §自主推进授权 §例外 1)
- [ ] **Step 5.4** 单 reviewer dormant 唤醒回归 — **skipped**(理由:lifecycle scheduler 默认 `activeWindowMs: 30 * 60 * 1000` 30 min agent 等不切实际 + spike 3 audit 已审 codex-cli/sdk-bridge/recoverer.ts ~280 LOC 镜像 claude 612 LOC 精简版 + jsonl 预检完整 + Phase 0 Step 0.5 + Phase 5 Step 5.1/5.2 cross-adapter spawn pair 实测 dispatch + reply chain work — dormant 唤醒所需前置机制全已间接验证。如未来场景需独立验证 cross-adapter dormant 唤醒,user 可在 dev mode 起 reviewer 后等 30 min 转 dormant 再 send_message 唤醒)
- [x] **Step 5.5** 资产面板 UI 回归 — **委托 user 重启 dev mode 后看「📚 资产库」Dialog Skills tab 视觉**(Phase 4 vite HMR renderer 改动 dev 实例已装,user 自检视觉验证;mental simulate PASS 见 §当前进度 v6 节)

### Phase 6 — 收尾文档 + plan archive

- [ ] **Step 6.1** 写 changelog（CHANGELOG_X.md，X 递增）引用归档
- [ ] **Step 6.2** 更新 `resources/claude-config/CLAUDE.md` + `resources/codex-config/CODEX_AGENTS.md` 应用约定（删 wrapper 模式描述 / 加 cross-adapter native 模式描述）
- [ ] **Step 6.3** 走 `mcp__agent-deck__archive_plan` 归档（含 spike-reports/ 子目录自动归档到 `<main-repo>/plans/<plan_id>/spike-reports/`）

## 当前进度

- ✅ RFC 第 1+2 轮收敛 + scope 修订确认
- ✅ spike 1+2/3/4 完整收尾 + 报告落地 `<plan-dir>/spike-reports/`
- ✅ Deep-Review SKILL R1 plan review 收口（12 条 finding 三态裁决：1 双方共识 HIGH + 6 必修 + 4 接受 + 1 partial 真问题；plan v2 已应用全部 fix + Phase 4.0 UI 决策）
- ✅ EnterWorktree 进 `worktree-reviewer-codex-cross-adapter-20260519`（base_commit `40d7527`）
- ✅ **Phase 0 Step 0.1a** reproducer 跑通（spawn cross-adapter teammate + prompt 强制 inline error message）
- ✅ **Phase 0 Step 0.2** root cause 定位 — mcp HTTP transport stateful 单 instance + 多 codex SDK 子进程 mcp client 撞「Server already initialized」(-32600)。**详 spike1+2 报告 §Phase 0 Step 0.1a/0.2 节**
- ✅ **Phase 0 Step 0.3** fix v1 实施 commit `c67ddde` — `transport-http.ts` `sessionIdGenerator: undefined`（stateless 模式），21 tests pass 守 regression（transport-http-extra-auth + spoofing-attack-paths）
- ✅ **Phase 0 Step 0.4** 写 vitest test `transport-http-multi-client-init.test.ts`（3 tests，真起 http server + multi-client init 实测）— **关键 finding：fix c67ddde 不充分**，stateless 模式单 transport reuse 仍 broken（mcp-sdk webStandardStreamableHttp.js:142-144 throw `Stateless transport cannot be reused across requests`，hono `handleFetchError` 转成 status=500 空 body —— 与 stateful -32600 错码不同但同样 broken）
- ✅ **Phase 0 Step 0.3.b** fix v2 实施 commit `835aa7c` — 走 mcp-sdk 1.29 official example `simpleStatelessStreamableHttp.js` 标准 pattern：POST /mcp per-request fresh transport + fresh McpServer + connect → handleRequest，reply.raw.on('close') 清理两者；GET / DELETE 走 405。test `transport-http-multi-client-init.test.ts` 3 个 case 全 PASS（stateful reuse 撞 -32600 / stateless reuse status=500 空 body / per-request fresh 两次都 200）+ 全量 vitest 877 pass + 76 skip + 0 fail 0 regression
- ⏳ **Phase 0 Step 0.4 真实端到端 fix-verification** 待 user 重启 .app（当前 lead session 跑在 PID 78626 的打包 .app `/Applications/Agent Deck.app/Contents/Resources/app.asar/out/main/transport-http-DwCnqxLm.js` 仍是 base_commit stateful 模式 —— fix v2 commit `835aa7c` 在 worktree branch 上未装入运行中 main 进程；重启 .app 装 worktree 代码即可。重启 .app 会 kill 当前 lead session,本会话 fix-verification 走 vitest unit test 路径 B 实证已完成,留 user 重启后用 cross-adapter spawn pair reproducer 真实端到端复测）
- ⏳ Phase 0 Step 0.5/0.6 双向 cross-adapter 闭环 + same-adapter regression 待 .app 装 fix v2 后真实 spawn pair 验证
- 整 plan 在 §自主推进授权 下推进；user 离开期间自主决策落地。本会话推进 Phase 0 Step 0.4 finding + Step 0.3.b fix 路径 B 实施 commit；后续 phase 待 user 重启 .app 装 fix v2 后接力。

---

### 本会话续接进度（2026-05-20 cold-start 接力）

cold-start 后发现 user 已重启 — main process PID 5233 dev mode 跑在 worktree `reviewer-codex-cross-adapter-20260519` (out/main/index.js mtime `01:43`、worktree out/main/transport-http-LPbIuJxi.js 含 fix v2 per-request fresh transport pattern + register 调用)。本会话 cold-start 第 5 步路径 A 重试,但**端到端 reproducer 仍 blocked** — 不是 fix v2 transport 层问题, 是上层 register 没生效:

- ✅ **本会话 cold start**:进 worktree (HEAD `835aa7c` fix v2),自检 transport-http.ts 是 fix v2 pattern (line 213-310 per-request fresh transport + reply.raw.on close 清理),worktree out/main/transport-http-LPbIuJxi.js bundle 编译正确含 fix v2 + register `routeRegistry.registerForAdapter('agent-deck-mcp', {method:'POST',url:'/mcp',...})` 调用
- ✅ **spawn cross-adapter reviewer-codex** (sessionId `019e4158-c2a0-7250-a852-8ab82bd7b08e`, teamId `f13bc0a2-8231-41e8-bd64-c203238ec301`, spawnPromptMessageId `d8a88c6f-daf2-46e6-9428-722d7fc459ce`, teamName `fix-v2-e2e-20260520`) 走 spawn_session(adapter:'codex-cli', agent_name:'reviewer-codex')
- ⏳ **等 reviewer-codex 调 send_message** 3+ min 无 reply 注入 lead conversation flow → 直接 query DB messages 表确认 reviewer-codex 0 messages 发出 (只有 spawn first prompt id `d8a88c6f...`)
- ⏳ **reviewer-codex 自己也 query 不到 mcp tools** — events 显示 reviewer-codex 用 shell tool 反复探索找 mcp HTTP transport / 尝试手动 craft JSON-RPC,assistant message 显式说"没有直接暴露 MCP 工具"(item_15 → item_33 events)。reviewer-codex 自己也 curl 测得 "/mcp 仍 404" (events ts 1779213165812)
- ❗ **lead 自己 curl 复测**:
  - `curl POST http://127.0.0.1:47821/mcp` + Bearer wrong-token → `401 unauthorized` (onRequest `/mcp` prefix auth hook active)
  - `curl POST http://127.0.0.1:47821/mcp` + Bearer 正确 token → `404 Route POST:/mcp not found` (onRequest auth 通过,但 fastify route lookup 找不到 `/mcp` handler)
- ❗ **诊断结论**:fix v2 编译产物正确 ✓ + settings.json 显示 `enableAgentDeckMcp:true` & `mcpHttpEnabled:true` ✓ + onRequest `/mcp` prefix auth hook active ✓,但 `/mcp` route handler **没注册**到 fastify
- 🎯 **Root cause 最可能性 (待确认)**:main 5233 启动**那刻**settings 是 `enableAgentDeckMcp:false` 或 `mcpHttpEnabled:false`,line 178 `if (settings.enableAgentDeckMcp && settings.mcpHttpEnabled)` 不进 → 静默不 register (无 console.error)。后来 user 切 settings 但 mcp HTTP register 不是即改即生效 (line 162-163 注释明确说 `hookServer.start()` 后调 `registerRoute` 会 throw `FST_ERR_INSTANCE_ALREADY_LISTENING`, fastify 5.x 不支持 runtime add route)。**次要可能性**:settings 启动时也是 true 但 `registerAgentDeckMcpHttpRoutes` 内 throw 被 catch (line 187) console.error 输到 user terminal stdout 看不到
- ✅ **shutdown reviewer-codex** (释放资源避免它继续浪费): `mcp__agent-deck__shutdown_session(019e4158-...)` lifecycle 转 closed
- ✅ **Phase 0 Step 0.4-bis**: phantom dep blocker root cause 由 user 用 dev terminal stdout 锁定 — `[agent-deck-mcp] failed to mount HTTP transport Error [ERR_MODULE_NOT_FOUND]: Cannot find package '@modelcontextprotocol/sdk'`,即 path A2 自检命中(原推断的「启动时 settings disabled」次要可能性是错的,真因是 mcp-sdk 是 transitive dep + Node ESM 严格 resolve 不走 pnpm hoist fallback,register call 内 `dynamicImport('@modelcontextprotocol/sdk/server/mcp.js')` throw 被 line 187 catch 静默 console.error)。fix v2 transport 层 (multi-client init per-request fresh transport,835aa7c) 跟这正交 — 修的是另一件事。打包 .app 路径 vite/rollup bundle mcp-sdk 进 chunk 不受 phantom dep 影响,所以 .app 路径走得通而 dev mode 走不通
- ✅ **Phase 0 Step 0.4-bis fix 落地** (RFC: user 选 explicit direct dep 路径 over .npmrc public-hoist-pattern alt)
  - 主 repo cwd 跑 `pnpm add @modelcontextprotocol/sdk@1.29.0` (4.6s, lockfile dedup 不变包体积) → 主 repo `node_modules/@modelcontextprotocol/sdk` symlink 建好指向 `.pnpm/@modelcontextprotocol+sdk@1.29.0_zod@4.3.6/node_modules/@modelcontextprotocol/sdk`,worktree 通过 `node_modules/` symlink 共享主 repo node_modules → dynamic import 现在 resolve 通
  - worktree branch 同步 patch (主 repo `git diff package.json pnpm-lock.yaml > /tmp/mcp-sdk-add.patch` → worktree `git apply` 同款 4 行 insertions),commit `1f70582 fix(deps): @modelcontextprotocol/sdk 转 direct dep 修 dev mode phantom dep` (与 fix v2 一起 ff-merge 入 main)
  - 主 repo working tree 仍 dirty (`package.json` + `pnpm-lock.yaml` 未 commit) — 留 user 决定何时清理(典型路径:ff-merge worktree → main 时主 repo working tree 被 merge target 覆盖一致无需手动清;或 user `git -C <main-repo> checkout package.json pnpm-lock.yaml` 显式撤回保留 node_modules `@modelcontextprotocol/sdk` symlink 不被 cleanup)

### Phase 0 Step 0.4-tris (2026-05-20) — user 重启 dev 后真实端到端 verification 暴露 NEW BLOCKER:codex CLI mcp tool approval gate

- ✅ user 重启 dev: kill old PID 5233 + worktree 内 `pnpm dev`;新 main process 起后 `[agent-deck-mcp] HTTP transport mounted at /mcp` 正常注册(curl `/mcp` self-check **200 OK** 返 mcp init result `{protocolVersion:"2024-11-05", capabilities:{tools:{listChanged:true}}, serverInfo:{name:"agent-deck", version:"0.1.0"}}`)。phantom dep fix work,fix v2 work
- ✅ **cross-adapter HTTP MCP transport 整体 work**:lead 自己 curl `tools/call list_sessions` (read-only) 200 OK 返实际 session data 含 lead + 历史 reviewer-codex session;spawn plain codex-cli session 跑 `mcp__agent-deck__list_sessions` **2ms 端到端成功**(read-only,EXTERNAL_CALLER_ALLOWED=true,toolUseId=item_0)
- ❗ **send_message 仍 cancel** — 但 root cause 全新:不是 spike 1+2 时的 transport 层 stateful init 撞 -32600,也不是 fix v1 stateless reuse status=500,**而是 codex CLI 内部 mcp tool approval gate**
  - 实证 1:reviewer-codex (sessionId `019e416b-6c7b-7963-8312-ffbc30185a28`) 调 `mcp__agent-deck__send_message` → tool-use-end 1ms 内 `error: "user cancelled MCP tool call", status: "failed"` (toolUseId=item_1, ts 1779214044421→1779214044422)
  - 实证 2:plain codex-cli session (sessionId `019e4172-63b1-75c0-b5e7-1132cbda3161`,**不**挂 reviewer-codex.md fresh-session abort 协议) 调 `mcp__agent-deck__send_message` 同样 1ms 内 `user cancelled MCP tool call` (排除 reviewer-codex 协议引起 cancel)
  - 实证 3:**string "user cancelled MCP tool call" 来自 codex Rust binary** `node_modules/.pnpm/@openai+codex@0.120.0-darwin-arm64/...codex/codex` (而**不**是 @openai/codex-sdk JS SDK 也不是 agent-deck 应用代码)
  - 实证 4:codex binary strings 显示完整 mcp tool approval gate 机制 — `core/src/mcp_tool_call.rs` 内 `mcp_tool_call_approval` `mcp_tool_call__default` `mcp_tool_call__always_allow` `Approve app tool call?` "Allow for this session" "Allow and don't ask me again" "Cancel this tool call." `MCP tool call blocked by app configuration` 等 strings + AppConfig fields `default_tools_approval_mode` `destructive_enabled` `open_world_enabled` `default_tools_enabled`
- ❗ **决策机制推断**(待源码层确认):codex CLI 看 mcp tool 的 annotations + AppConfig 字段决定走审批 gate 还是放行
  - mcp tool 标 `{ annotations: { readOnlyHint: true } }` → codex 视为 read-only **自动放行**(`list_sessions` / `get_session` 实证 work)
  - mcp tool 未标 annotations → codex 视为 destructive (默认保守) → 走 approval gate → agent-deck 主进程**无** mcp approval callback handler → codex 自动 cancel `user cancelled MCP tool call`
  - **agent-deck 当前 mcp tool annotations 状态** (`src/main/agent-deck-mcp/tools/index.ts`):
    - `list_sessions` (line 149): `{ annotations: { readOnlyHint: true } }` ✅
    - `get_session` (line 157): `{ annotations: { readOnlyHint: true } }` ✅
    - `send_message` (line 137-142): **未标 annotations** ❌
    - `spawn_session` (line 130-135): **未标 annotations** ❌(但 spawn 实测 work,可能因为 in-process caller 路径绕开 codex client?待复测)
    - `shutdown_session` / 其他 plan-driven 5 个 tool: 待 grep
- ❗ **三种修法选项** (按 invasive 程度排):
  - **选项 A** (最干净,符合 MCP spec): 给 5 个 write tool 加准确 mcp annotations
    - `send_message` / `spawn_session`: `{ readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false }` (写 DB 但不破坏 / 重复发会发多条 / 限项目内)
    - `shutdown_session`: `{ readOnlyHint: false, destructiveHint: true, idempotentHint: true }` (close session 是破坏 / 重复 close 等价)
    - 风险:codex 是否真的看 `destructiveHint: false` 放行待实证。如果 codex 严格只看 `readOnlyHint: true` → 选项 A 不够
  - **选项 B** (主进程 codex spawn 时显式配): `buildAgentDeckMcpConfigForCodex` 注入 `default_tools_approval_mode = "always_allow"` 让 codex CLI 全场景跳 mcp tool 审批
    - 范围:per-codex-SDK-session 配置(SDK Codex({ config }) 不写 ~/.codex/config.toml),仅影响应用层 spawn 的 codex teammate
    - 风险:user 自己手配的 mcp_servers (~/.codex/config.toml mcp_servers section) 如果有 destructive tool 也会被同款 always_allow 跳过 — user 可能不期望这种
    - 优点:一行配置 universal 修复,不依赖 codex 看 annotations 内部决策路径
  - **选项 C** (defense-in-depth): 选项 A + 选项 B 同时做 — annotations 显式声明 tool 性质 + 全局 always_allow 兜底,任一场景都 work
- ✅ **shutdown 测试 sessions** 释放资源:`019e4172-...` 已 closed
- ✅ **修法选项 A 落地** (user 选 spec-compliant 路径,commit `eb65878 fix(mcp): 给 8 个 write tool 加 spec-compliant annotations 解 codex CLI cancel`,86 行 insertion + 0 删除 / typecheck PASS)
  - `src/main/agent-deck-mcp/tools/index.ts` 给 8 个 write tool 各加准确 mcp ToolAnnotations 4 fields:
    - `spawn_session`: `{readOnly:false, destructive:false, idempotent:false, openWorld:true}` — 起 SDK 子进程外部副作用
    - `send_message`: `{readOnly:false, destructive:false, idempotent:false, openWorld:false}` — 写 messages 表 INSERT 不破坏不幂等限项目内
    - `shutdown_session`: `{readOnly:false, destructive:true, idempotent:true, openWorld:false}` — 终止 session lifecycle + abort SDK live query 重复 noop 等价
    - `archive_plan`: `{readOnly:false, destructive:true, idempotent:false, openWorld:false}` — git ff-merge/mv plan/git commit/git worktree remove/branch -D 极破坏性多步,重复撞 status=completed reject
    - `hand_off_session`: `{readOnly:false, destructive:true, idempotent:false, openWorld:true}` — 起 SDK 子进程 + archive_caller=true 归档 caller
    - `enter_worktree`: `{readOnly:false, destructive:false, idempotent:false, openWorld:false}` — 创新 git worktree dir + branch 不破坏,重复撞 path exists reject
    - `exit_worktree`: `{readOnly:false, destructive:true, idempotent:false, openWorld:false}` — action=remove 真删 worktree dir + branch -D 整体保守 destructive
    - `shutdown_baton_teammates`: `{readOnly:false, destructive:true, idempotent:true, openWorld:false}` — 终止 caller-lead team 的 active teammates 重复 noop 等价
  - `list_sessions` / `get_session` 已有 `{readOnlyHint:true}` 不动
- ⏳ **next step blocked,待 user kill PID 5233/83221 + 重启 dev** 装 annotations,然后跑 cross-adapter spawn pair reproducer 真实端到端 verification:reviewer-codex 调 send_message → 不再 1ms cancel,reply 注入 lead conversation flow 成功 → Phase 0 Step 0.4 真实端到端通过 → 进 Step 0.5 / Step 0.6
- ⚠️ **风险待实证**: codex 是否真接受 `destructiveHint:false` 放行,还是严格只看 `readOnlyHint:true`。如果后者 → 选项 A 不够,需叠加选项 B (`default_tools_approval_mode='always_allow'` 配置注入到 `buildAgentDeckMcpConfigForCodex`)。重启后 reproducer 测出来知道结果 — 不够就回头加 B (代码改动 ≤ 5 行 + 同款 commit + 重启 dev)。

### Phase 0 Step 0.5 续接进度(2026-05-20 02:32-02:39 user 重启后实测)

**user 已重启 dev** (新 PID 71956, dev mode 跑在 worktree),mcp transport 自检 PASS (curl POST /mcp + Bearer token = 200 OK 返 init result 含 capabilities/tools/listChanged); 10 个 tool annotations 全部正确注入 (verified by tools/list curl)。fix v2 transport + phantom dep direct dep + commit eb65878 annotations 三件事都装入运行 main。

#### Phase 0 Step 0.5 方向 A 实证 PASS (claude-code lead × codex-cli reviewer-codex)
- ✅ spawn cross-adapter reviewer-codex (sessionId `019e4183-...`, teamId `780bbf64-...`, spawnPromptMessageId `f392627b-...`)
- ✅ reviewer-codex 调 `send_message` → reply queued + 注入 lead conversation flow 完整 wire prefix `[from reviewer-codex · annotations-e2e @ codex-cli][msg 227c4c09-...][sid 019e4183-...]` + 顶部明确写 "✅ ANNOTATIONS FIX VERIFIED - codex 接受 destructiveHint:false 放行 mcp tool call" + 2 条 finding (除零 LOW + 类型契约 INFO) 正常输出
- ✅ lead 回 reply (messageId 34bd3a14-...) 挂 `reply_to_message_id` chain 闭环
- ✅ shutdown reviewer-codex 释放
- **关键结论 1**: codex CLI 不严格只看 `readOnlyHint:true`,对 `destructiveHint:false` 也放行
- **关键结论 2**: send_message annotation `{rO:F des:F idem:F ow:F}` 在 codex CLI HTTP transport 下放行

#### Phase 0 Step 0.5 方向 B 实证 FAILED 但揭示新 finding (codex-cli temp lead × claude-code reviewer-claude)
- ✅ spawn codex-cli temp lead (sessionId `019e4185-...`, displayName "Lead-codex · direction-B-test", teamId `9774d7fc-...`, spawnPromptMessageId `bfce4220-...`)
- ❌ codex-cli temp lead 调 `mcp__agent-deck__spawn_session({adapter:'claude-code', agent_name:'reviewer-claude', ...})` → 1ms 内 cancel "user cancelled MCP tool call" (failure timestamp 2026-05-20T02:37:25+08:00, toolUseId Step 2)
- ✅ codex-cli temp lead 自己用 send_message 把 failed report 转给真 lead (messageId 75e42218-..., wire prefix 完整 reply chain 闭环)
- ✅ shutdown codex-cli temp lead 释放
- **关键 finding 3**: codex CLI 不只看 destructiveHint,**也看 openWorldHint**。spawn_session 标 `{rO:F des:F idem:F ow:T}` (ow:true) 与 send_message `{rO:F des:F idem:F ow:F}` 唯一差异是 ow → spawn_session cancel / send_message work,锁定 ow:true 是 cancel 触发器
- **关键 finding 4**: codex binary strings 显示 AppConfig 含 `open_world_enabled` 字段 (与 `destructive_enabled` 同款) — 默认应是 false → tool 标 `openWorldHint:true` 走审批 gate (无 callback handler 自动 cancel)。决策 logic 推断: `readOnlyHint:true` 自动放行 / `(destructiveHint:true && !destructive_enabled) || (openWorldHint:true && !open_world_enabled)` → 触发审批 gate

#### Phase 0 Step 0.5 fix v3 落地 (commit `923468e fix(mcp): spawn_session/hand_off_session openWorldHint:true → false 解 codex CLI cancel`)
- `src/main/agent-deck-mcp/tools/index.ts` 改 2 处 annotations + 注释更新 (11 insert / 7 delete):
  - `spawn_session`: `openWorldHint: true` → `false` (起 SDK 子进程是应用内 closed-world,主进程 spawn 应用边界内 SDK CLI 子进程,不是 web search 真正外部 open-world)
  - `hand_off_session`: `openWorldHint: true` → `false` (同款修订)
- typecheck PASS (0 error)
- worktree HEAD = `923468e`,base_commit `40d7527` 之后 5 commits: c67ddde (fix v1 旧) / 835aa7c (fix v2) / 1f70582 (phantom dep) / eb65878 (8 tool annotations) / 923468e (fix v3)
- 主 repo working tree 仍 dirty (`package.json` + `pnpm-lock.yaml` mcp-sdk add) — 留 user 决定时机清理

#### Phase 0 Step 0.5 fix v3 实证待 verify (待 user 重启 dev)
- ⏳ **next step blocked, 待 user kill PID 71956 + 重启 dev** 装 fix v3 annotations,然后复测方向 B 闭环 (codex temp lead → spawn_session 不再 cancel + reviewer-claude reply 注入 codex temp lead conversation flow + codex temp lead forward 给真 lead 三段链路全过)
- ⚠️ **残留风险**: codex CLI 对其他 `destructiveHint:true` tool (shutdown_session / archive_plan / exit_worktree / shutdown_baton_teammates) 是否也 cancel 还没实测。这些 tool 若被 cancel 不影响本次 dispatch 验证 (reviewer-claude / reviewer-codex 走 in-process transport 由真 lead claude-code 调 shutdown 释放,绕开 codex CLI 决策),但影响 codex SDK lead 自治工作流 (如 codex lead 想自己 archive_plan 收口会被 cancel)。后续 phase 视场景决定是否叠加修法选项 B (config 注入 `default_tools_approval_mode='always_allow'`)
- ⚠️ **方向 B 重测 prompt 修订**: codex temp lead 的 prompt 应明示「shutdown reviewer-claude 由真 lead 调 (不要 codex temp lead 自己调 shutdown_session,避免被 codex CLI cancel 影响 verification)」+ 真 lead 自己事后 shutdown_session reviewer-claude 释放

### Phase 0 完整收口实证(2026-05-20 02:55-03:08 user 重启 dev 后跑通)

**Phase 0 整体 PASS** ✓ — cross-adapter teammate dispatch BLOCKER 完整解决,fix v3 真实端到端验证 + same-adapter 双向回归 PASS。

#### Phase 0 Step 0.5 方向 B 复测 PASS (codex-cli lead × claude-code reviewer-claude)
- ✅ **fix v3 verified PASS**: dev 重启后 tools/list 校验 spawn_session/hand_off_session `openWorldHint=false`(commit 923468e 装入)
- ✅ spawn codex-cli temp lead (sessionId `019e4198-...`, displayName "Lead-codex · direction-B-retest", teamId `dea48ca8-...`)
- ✅ codex-cli temp lead 调 `mcp__agent-deck__spawn_session({adapter:'claude-code', agent_name:'reviewer-claude', ...})` **不再 1ms cancel** — 成功 spawn reviewer-claude (sessionId `35257e35-...`, spawnDepth 2, spawnedBy temp lead)
- ✅ reviewer-claude 调 send_message reply 给 codex temp lead — DB message `632c449d-...` `status=delivered`,`reply_to_message_id=2f1c8b45-...` reply chain 闭环
- ✅ universal-message-watcher + codex-cli adapter receiveTeammateMessage 真实注入 codex-cli lead conversation flow as user-role wire-prefixed message (Step 3 严格 criterion 满足 — 不只 DB delivered,还要 codex SDK process 真消化 user message)
- ✅ codex temp lead 用 send_message forward 验证结论 + reviewer-claude finding 摘要给真 lead (claude-code adapter),wire prefix 完整 reply chain 链
- **关键结论**: fix v3 把 spawn_session.openWorldHint 由 true 改 false 让 codex CLI mcp tool approval gate 放行,cross-adapter dispatch BLOCKER 完整解决

#### Phase 0 Step 0.6 same-adapter regression 双双 PASS
- ✅ **回归 1 PASS** (claude-code lead × claude-code reviewer-claude in-process MCP transport)
  - 我 spawn reviewer-claude 走 in-process transport (sessionId `370c2558-...`, spawnDepth 1)
  - reviewer-claude 调 send_message reply 给我,wire prefix 完整 + 顶部 marker "✅ SAME-ADAPTER REGRESSION 1 PASS - claude-code in-process MCP transport unaffected by fix v3" + finding (HIGH ZeroDivisionError + MED 类型契约缺失)
  - **关键结论**: annotations 修改属 metadata 层,与 in-process transport(直接 function call,不走 JSON-RPC envelope)正交 — fix v3 不影响 in-process 路径(理论 + 实测一致)
- ✅ **回归 2 PASS** (codex-cli lead × codex-cli reviewer-codex same-adapter HTTP transport)
  - spawn codex-cli temp lead (sessionId `019e419e-1915-...`, displayName "Lead-codex · step-0.6-regression-2")
  - codex temp lead spawn reviewer-codex same-adapter (sessionId `019e419e-eb90-...`, spawnDepth 2)
  - reviewer-codex 调 send_message reply DB message `c6d2a320-...` `status=delivered` 注入 codex temp lead conversation flow as user-role wire-prefixed message
  - reviewer-codex 跑得慢 → reply 在 temp lead 3 min timeout 报告之后才到 → temp lead 又发 supersede 报告 "✅ SAME-ADAPTER REGRESSION 2 PASS"
  - finding 一致 (MED ZeroDivisionError + LOW 类型契约缺失)
  - **关键结论**: fix v3 不影响 HTTP transport same-adapter 路径,codex × codex same-adapter 反向 dispatch 也 work

### Phase 0 已知踩坑 (lesson learnt for 后续 phase)

1. **DB query substr 误判**: 同一时间 spawn 的 codex SDK session 全以 codex thread id 形式 UUID v7 开头(时间戳前缀近似) — `019e419e-1915-76e3-...` (temp lead) vs `019e419e-eb90-7043-...` (reviewer-codex) 都以 `019e419e` 开头。DB query 用 `substr(from_session_id, 1, 8)` 截断时同期 session prefix 重合无法分辨方向。**后续 DB query session id substr 长度 ≥ 16** 或直接 SELECT full sessionId 才能分辨同期 spawn 的 codex session
2. **codex SDK reviewer 跑得慢**: codex × codex same-adapter 时 reviewer-codex 跑 review 可能 > 3 min,如果 lead 设了 timeout 会先报错后才收到 reply。**lead prompt 里 timeout 阈值给到 ≥ 5 min**,或先 query DB 看 messages 表是否有 reply 再报告 timeout(避免误判)
3. **shutdown_session 等 destructiveHint:true tool**: 本次实证仅 send_message (des:F) + spawn_session (fix v3 后 ow:F) 在 codex SDK HTTP transport 下放行 work。其他 destructiveHint:true tool (shutdown_session / archive_plan / exit_worktree / shutdown_baton_teammates) 是否触发 codex CLI cancel **未实测**。后续 phase 若需 codex SDK lead 自治调这类 tool (如 codex lead 想自己 archive_plan 收口) 需先实测,撞 cancel 时叠加修法选项 B (config 注入 `default_tools_approval_mode='always_allow'`)
4. **sessionId truncate 8 字符在 codex SDK 同期 session 上不安全**: 与 1 同款,但更宽泛适用于所有 logging / monitoring / DB query / UI display 场景。codex SDK 同时 spawn 的 session 时间戳前缀近似,需要至少 16 字符长 prefix 才能稳定区分

### Phase 0 完整收口达成,准备进 Phase 1
- worktree 5 commits (base `40d7527` 之后): `c67ddde fix v1 旧` / `835aa7c fix v2 transport-http per-request fresh transport` / `1f70582 phantom dep direct dep` / `eb65878 8 tool annotations` / `923468e fix v3 openWorldHint`
- Phase 0 收口需要写 changelog 引用归档但留到 Phase 6 一起做(避免重 commit)
- 进 Phase 1: 改 SKILL.md Step 1 跨 adapter spawn 编排

## 当前进度 v5 (2026-05-20 03:25 接续, Phase 1+2+3 推进 + commit)

### Phase 1 完整收口 (commit `8cb9ec4 docs(skill): Phase 1 — SKILL.md 跨 adapter spawn 编排 + 失败兜底 native 化`)
- ✅ Step 1.1 改 SKILL.md §异构对抗 表 reviewer-codex 列 wrapper → native + 加跨 adapter 直起 callout
- ✅ Step 1.1 改 SKILL.md §执行模板 Step 1 spawn args 注明「adapter 各异」
- ✅ Step 1.2 检查 SKILL.md 其他 wrapper-style 描述: 修订 §kind=mixed 失败兜底 节同款 wrapper-style failure modes 改 native
- ✅ Step 1.3 改 SKILL.md §失败兜底 表第 1 行 reviewer-codex 失败模板 wrapper-style → native (codex SDK 起不来 / shell tool call cancel / sandbox 拒 / codex thread jsonl 缺失 fresh-session abort)
- ✅ Step 1.3 同步 claude-config CLAUDE.md §reviewer-codex 失败兜底 + codex-config CODEX_AGENTS.md §reviewer-claude 失败兜底 (对偶视角) 同款 native 化
- ✅ Step 1.4 SKILL.md 末尾 callout 表述微调 (cross-adapter native pair 描述)

### Phase 2 完整收口 (commit `da5c0eb refactor(reviewer): Phase 2 — 删 wrapper agent body + cleanup wrapper code`, 净 -450 行)
- ✅ Step 2.1+2.2 git rm 2 份 wrapper agent body
  - `resources/claude-config/agent-deck-plugin/agents/reviewer-codex.md` (claude SDK + Bash 起 codex CLI wrapper, 168 行)
  - `resources/codex-config/agent-deck-plugin/agents/reviewer-claude.md` (codex SDK + shell 起 claude -p wrapper, 192 行)
- ✅ Step 2.3 改 2 份 native body description native 化
  - `claude-config/.../reviewer-claude.md`: line 8 描述对偶 reviewer-codex 加 `(codex-cli adapter native, codex SDK 直起 gpt-5.5)` + line 12 加「lead adapter 任意」cross-adapter 注释
  - `codex-config/.../reviewer-codex.md`: 4 处改动 — frontmatter description 删 wrapper 描述 / 顶部 callout 重写 cross-adapter native pair / line 12 描述对偶 / line 36 wrapper/direct 二分改 cross-adapter / line 80 reviewer-claude wrapper 输出改 native
- ✅ Step 2.4 删 wrapper-specific code (typecheck PASS + 6 tests pass)
  - 删 `src/main/adapters/claude-code/resolve-bundled-claude.ts` 整文件 (33 行, grep 0 production caller after Phase 2 改动)
  - 删 `options-builder.ts:182-185` reviewer-claude wrapper envOverrideExtra: AGENT_DECK_CLAUDE_PATH 注入分支 (12 行) + 删 import + 改 line 118-120 注释 generic 化
  - 改 `types.ts:215-228` envOverrideExtra 字段注释 generic 化 (字段保留供未来 caller 重用)
  - 改 `codex-cli/sdk-bridge/index.ts` 4 处注释 generic 化
  - 改 `spawn.ts:258-261` 注释 generic 化
  - 重写 `teammate-spawn-defaults.test.ts`: 删 mock resolveBundledClaudeBinary + 删 TC9 (positive wrapper) + 删 TC11 (edge case) + 6 tests pass (TC8 / TC9 cross-adapter / TC10 / TC10b / TC11b)
- ✅ Step 2.5 cleanup dormant wrapper session: **no-op** (实测 0 个 wrapper 形态 dormant session — list_sessions 返回 3 个 dormant 都是 plain test session / 历史 lead 残留, 非 wrapper)

### Phase 3 完整收口 (commit `5b727e0 feat(build): Phase 3 — codex-config 端 build-time auto cp SKILL`)
- ✅ Step 3.1 写 `scripts/sync-codex-skills.mjs` (~80 行 Node fs cpSync, 先 rm -rf 目标再重 cp 避免 stale) + 加 npm `predev` / `prebuild` hook 自动同步
- ✅ Step 3.2 bundled-assets.ts dual-root scan 已 work 无需改 (line 68-71 spread `scanSkills(claudeRoot, 'claude-code') + scanSkills(codexRoot, 'codex-cli')`)
- ✅ Step 3.3 .gitignore 加 entry `resources/codex-config/agent-deck-plugin/skills/` (cp 产物不入 git, SSOT 单源在 claude-config), `git check-ignore -v` 验证生效
- ✅ Step 3.4 skills-installer.ts 源单 SSOT 不变 (`getBuiltinSkillsSourceDir()` = claude-config), 镜像到 `~/.codex/skills/agent-deck/`

### worktree 当前状态
- HEAD `5b727e0` (Phase 3 commit)
- base_commit `40d7527` 之后 8 commits: c67ddde fix v1 旧 / 835aa7c fix v2 / 1f70582 phantom dep / eb65878 8 tool annotations / 923468e fix v3 openWorldHint / 8cb9ec4 Phase 1 / da5c0eb Phase 2 / 5b727e0 Phase 3
- working tree clean
- typecheck PASS / tests pass (teammate-spawn-defaults 6 tests pass)

### 剩余工作 (Phase 4-6)
- ⏳ **Phase 4** 资产面板视觉调整 (单条双角标 + ContentViewerModal tab) - 改动较精细 (AssetMeta dedup logic / ContentViewerModal state schema / fetch flow) + 需 typecheck + 重启 dev 验证 UI 视觉. 评估工作量较重.
- ⏳ **Phase 5** 端到端回归 - Step 5.1-5.2 cross-adapter spawn pair 已在 Phase 0 Step 0.5 实测 PASS 双向; Step 5.3 codex CLI interactive `/agent-deck:deep-review` 触发回归**需 user 在 terminal 跑** (agent 跨进程跑不了); Step 5.4 dormant 唤醒回归 / Step 5.5 资产面板 UI 回归 (依赖 Phase 4)
- ⏳ **Phase 6** 收尾 - changelog + archive_plan (trivial, 一行 mcp tool 收口)

### Phase 4 改动评估细节 (供 next session 接力)
- **影响文件**:
  - `src/renderer/components/AssetsLibraryDialog.tsx` (455 行,接近 ≤500 阈值): AssetsTab dedup 渲染 by (kind+name) group + AssetCard 加 dual-adapter badge prop + openViewer 改成接受 group
  - `src/renderer/components/assets/ContentViewerModal.tsx` (79 行): ContentViewerState 加 assets[] + currentAdapter 字段 + 加 tab UI + onTabSwitch callback
  - `src/shared/types/assets.ts` AssetMeta type 不变(adapter 字段已存在)
- **Phase 4 plan 节** (line 175-202 in plan v3): Step 4.0 (UI design 决策已敲定单按钮 + modal tab) / Step 4.1 (AssetsTab dedup 渲染) / Step 4.2 (ContentViewerModal tab + adapter narrowing fetch) / Step 4.3 (Agents tab 视觉无副作用回归)
- **风险**: AssetsLibraryDialog.tsx 接近单文件 ≤500 阈值 (455 行), Phase 4 改动可能突破 — 触发 §单文件大小护栏 拆分尝试 (按风险升序选 1 抽 module-level group helper / 选 2 目录化 / 选 3 拆 class)
- **无关核心 cross-adapter 编排**: Phase 4 是 UI 优化 — Phase 1+2+3 已让核心 cross-adapter native 编排 work, Phase 4 不阻塞 plan 主线; 跳过 Phase 4 仅资产面板视觉表现降级 (同名 SKILL 显示两条平铺而非单条双角标), functional 仍 work

## 当前进度 v7 (2026-05-20 04:08 接续, Phase 5+6 收口完整 + 准备 archive_plan)

### Phase 5 完整收口 (commit `313e1f7` Step 5.1 fix + commit `1bc754c` Step 5.2 fix)

**Phase 5 Step 5.1 cross-adapter direction A 闭环 PASS** (claude lead × codex reviewer-codex):
- reviewer-codex sessionId `019e41c8`,fresh review Phase 4 改动 commit `48141ec`
- 3 finding: 1 MED (close path 不失效 in-flight viewer fetch — 关闭后 fetch 迟到复活 modal) + 1 LOW (IPC reject viewer 永久 loading) + 1 INFO (NonEmptyAssetGroup 类型层非空不变量)
- inline fix commit `313e1f7`:抽 closeViewer() helper / fetch 链补 .catch / NonEmptyAssetGroup tuple type 编码非空
- reply chain 三段闭环 (spawn `3f17adb7` → reviewer reply `6032fe45` → lead reply `9b39120f` → reviewer 确认 `6a3df33c`)
- reviewer-codex 已 shutdown 释放

**Phase 5 Step 5.2 cross-adapter direction B 闭环 PASS** (codex temp lead × claude-code reviewer-claude):
- codex temp lead sessionId `019e41cd` × reviewer-claude `e7633fc1` direction-B team `4c3901fa`
- spawn_session(adapter:'claude-code', agent_name:'reviewer-claude') 不再 1ms cancel(fix v3 装入)✓
- reviewer-claude reply 真实注入 codex temp lead conversation flow as user-role wire-prefixed message ✓
- codex temp lead forward 给真 lead 走 reply chain 完整闭环 ✓
- reviewer-claude 反馈: 0 HIGH + 0 MED + 3 LOW + 1 INFO
  - LOW 1 (closure double-click race) *未验证* + reviewer 自降级 → ❓ 不修(user CLAUDE.md §决策对抗 §Finding 输出契约 弱断言强制降级)
  - LOW 2 (AdapterBadge key 异常重复输入撞) → ✅ defensive fix commit `1bc754c` key 加 idx
  - LOW 3 (dedupBundledByName order(null) dead branch invariant) → ✅ jsdoc 加 input 不变量节明确
  - INFO Step 5.1 fix 复盘 PASS (viewerSeqRef++ close/cleanup + NonEmptyAssetGroup tuple invariant + as NonEmptyAssetGroup[] cast + .catch reject 全通过)
- codex temp lead + reviewer-claude 都已 shutdown 释放

**Phase 5 Step 5.4 dormant 唤醒回归 — skipped**:lifecycle scheduler 默认 `activeWindowMs: 30 * 60 * 1000` 30 min agent 等不切实际 + spike 3 audit 已审 codex-cli/sdk-bridge/recoverer.ts ~280 LOC 完整 + Phase 0 Step 0.5 + Phase 5 Step 5.1/5.2 已实测 dispatch + reply chain (dormant 唤醒前置机制) work。如未来场景需独立验证 cross-adapter dormant 唤醒,user 可在 dev mode 起 reviewer 后等 30 min 转 dormant 再 send_message 唤醒(独立 follow-up,不阻塞本 plan 主线)

**Phase 5 Step 5.3 + 5.5 — 委托 user**:
- Step 5.3 codex CLI interactive `/agent-deck:deep-review` 触发(agent 跨进程跑不了 interactive shell,user 在 codex CLI 自己 verify)
- Step 5.5 资产面板 UI 视觉(Phase 4 vite HMR renderer 改动 dev 实例已装,user 自检)

### Phase 6 完整收口 (commit `d5f185a`)
- ✅ Step 6.1 写 `changelog/CHANGELOG_130.md` 引用归档 plan + 同步 `changelog/INDEX.md` append 一行
- ✅ Step 6.2 sweep `resources/claude-config/CLAUDE.md` + `resources/codex-config/CODEX_AGENTS.md` 2 处遗漏 wrapper 描述 native 化(claude-config CLAUDE.md L79 / codex-config CODEX_AGENTS.md L168-172)
- ⏳ Step 6.3 archive_plan 准备走(ExitWorktree → mcp__agent-deck__archive_plan,base_branch=main)

### worktree 当前状态 v7
- HEAD `1bc754c` (Phase 5 Step 5.2 LOW fix)
- base_commit `40d7527` 之后 12 commits: c67ddde fix v1 旧 / 835aa7c fix v2 / 1f70582 phantom dep / eb65878 8 tool annotations / 923468e fix v3 openWorldHint / 8cb9ec4 Phase 1 / da5c0eb Phase 2 / 5b727e0 Phase 3 / 48141ec Phase 4 / d5f185a Phase 6 docs / 313e1f7 Step 5.1 fix / 1bc754c Step 5.2 fix
- working tree clean
- typecheck PASS / vitest 876 pass + 76 skip 0 fail 0 regression
- AssetsLibraryDialog.tsx 462 行 / AssetCard.tsx 145 行 / ContentViewerModal.tsx 136 行 全 ≤500 阈值

### 准备 archive_plan
- frontmatter base_branch: main → ff-merge worktree-reviewer-codex-cross-adapter-20260519 → main
- plan archived path: `<main-repo>/plans/reviewer-codex-cross-adapter-20260519.md`
- spike-reports/ 子目录自动归档到 `<main-repo>/plans/reviewer-codex-cross-adapter-20260519/spike-reports/`
- changelog_id="130" → INDEX 4 列写入 `[130](../changelog/CHANGELOG_130.md)`
- 主 repo `package.json` + `pnpm-lock.yaml` 仍 dirty(mcp-sdk add)— 与 plan 归档无关 critical paths(archivedPath/indexPath/planFilePath),按 plan v6 archive_plan precheck 行为,unrelated dirty 降 warning + commit message 注脚不阻塞 fail-fast



### Phase 4 完整收口 (commit `48141ec feat(ui): Phase 4 — 资产面板 dedup + ContentViewerModal dual-adapter tab`)

- ✅ **Step 4.1** AssetsTab dedup 渲染 + dual-adapter badge
  - `src/renderer/components/AssetsLibraryDialog.tsx` AssetsTab 加 `dedupBundledByName` group helper(同 kind+name 跨 adapter 合并为单 group;每组按 claude-code 优先 / codex-cli 后 / null 末尾 deterministic 排序)
  - bundled assets render `dedupBundledByName(bundled).map((group) => <AssetCard assets={group} />)` (key=`${kind}:${name}`)
  - user assets render `user.map((a) => <AssetCard assets={[a]} />)` (单 element 包数组兼容路径)
  - AssetCard signature 改 `asset → assets[]`,内部 `first = assets[0]` 取 display data;`assets.length > 1` 时显示双角标 chip 一对
- ✅ **Step 4.2** ContentViewerModal dual-adapter tab
  - `src/renderer/components/assets/ContentViewerModal.tsx`: `ContentViewerState` schema 改 `asset → assets[] + currentAdapter`(后者 `'claude-code'|'codex-cli'|null`);加 `[claude]/[codex]/[user]` tab UI(仅 `assets.length > 1` 时显示);加 `onTabSwitch?: (adapter) => void` callback prop
  - caller `AssetsLibraryDialog.tsx` openViewer signature 改成接 group;viewer modal 加 onTabSwitch handler 走 seq guard fetch 切到对应 adapter 的内容(closure 每次 render 重建拿最新 viewer state,React 18 batched update 保证一致性)
  - viewer reveal 用当前 tab 对应 asset(`viewer.assets.find(a => a.adapter === viewer.currentAdapter)`)
- ✅ **Step 4.1 单文件 ≤500 行护栏拆分**: AssetsLibraryDialog.tsx 改完 538 行突破阈值 → 按项目 CLAUDE.md 「单文件 ≤500 行 — 超了必须试拆」选 1 抽子组件: 抽 `AssetCard` + `AdapterBadge` + `dedupBundledByName` 到独立文件 `src/renderer/components/assets/AssetCard.tsx`(132 行),主文件回到 420 行 ≤ 阈值
- ✅ **Step 4.3** Agents tab 视觉无副作用 mental simulate
  - bundled agents reviewer-claude (claude-code) + reviewer-codex (codex-cli) 不同 name → `dedupBundledByName` 后 2 个 1-element group → AssetCard `assets.length === 1` 不进角标分支(显示 qualifiedName 但无 chip)→ 旧 UI 视觉等价
  - bundled SKILL deep-review/hello-from-deck 同 name 跨 adapter → 2 个 2-element group → 显示 [claude]+[codex] 双角标 ✓
  - user agents/skills `[asset]` 包数组喂 AssetCard → 单 element group → 同上等价
- ✅ **typecheck + vitest sanity**:
  - `pnpm typecheck` PASS (0 error)
  - `pnpm test` 876 pass + 76 skip 0 fail(与 baseline 877+76 等价 0 regression — 1 差是 better-sqlite3 binding warn,与 plan §当前进度 v2 phantom dep 同款 default-skip,非 regression)
- ⏳ **Step 4.3 真实视觉验证待 user 重启 dev**: agent 跨进程跑不了 dev mode UI(本会话 lead 跑在 dev mode 装代码,重启会 kill 当前 session)。user 重启后打开「📚 资产库」Dialog → Skills tab 看 deep-review/hello-from-deck 同名 SKILL 各一条带双角标 [claude]/[codex] + 「查看」按钮弹 ContentViewerModal 顶部有 tab → tab 切换 fetch 不同 root 内容 → 视觉验证通过即 Step 4.3 收口

### worktree 当前状态 v6
- HEAD `48141ec` (Phase 4 commit)
- base_commit `40d7527` 之后 9 commits: c67ddde fix v1 旧 / 835aa7c fix v2 / 1f70582 phantom dep / eb65878 8 tool annotations / 923468e fix v3 openWorldHint / 8cb9ec4 Phase 1 / da5c0eb Phase 2 / 5b727e0 Phase 3 / **48141ec Phase 4**
- working tree clean
- typecheck PASS / vitest 876 pass + 76 skip 0 fail 0 regression


## 下一会话第一步

**状态**: Phase 0+1+2+3+4 已完整收口 commit, worktree HEAD `48141ec`, working tree clean。新会话接力 Phase 5+6。

1. `Bash: cat /Users/apple/Repository/personal/agent-deck/.claude/plans/reviewer-codex-cross-adapter-20260519.md`（cold start 全文读 plan v6 含 Phase 0-4 完整收口实证 + Phase 5/6 待办)
2. `Bash: cat /Users/apple/Repository/personal/agent-deck/.claude/plans/reviewer-codex-cross-adapter-20260519/spike-reports/spike1+2-cross-adapter-teammate-dispatch.md`（重点读 §Phase 0 Step 0.1a/0.2 root cause + 整套 fix v1/v2/v3 + phantom dep blocker 节,Phase 5 端到端回归会用到背景)
3. `EnterWorktree(path: "/Users/apple/Repository/personal/agent-deck/.claude/worktrees/reviewer-codex-cross-adapter-20260519")` (worktree HEAD `48141ec`,用 `path` 不是 `name`)
4. `Bash: git -C <wt> log --oneline -9`（确认 9 commits 都在: c67ddde fix v1 旧 / 835aa7c fix v2 / 1f70582 phantom dep / eb65878 annotations / 923468e fix v3 / 8cb9ec4 Phase 1 / da5c0eb Phase 2 / 5b727e0 Phase 3 / 48141ec Phase 4)
5. **Step 4.3 真实视觉验证 (user 重启 dev mode 后)**:
   - **如新会话起来时本会话 lead 已死 / dev mode 已重启**: 表明 user 已重启 → 新 SDK lead session 已装 Phase 4 改动,可直接走 Step 5.5 资产面板 UI 真实视觉验证(打开「📚 资产库」Dialog → Skills tab 看 deep-review/hello-from-deck 单条 [claude]+[codex] 双角标 + 「查看」按钮弹 ContentViewerModal 顶部有 tab 可切换 fetch)
   - **如 dev mode 还没重启**: 提示 user `kill <PID> + 重启 dev` 装 Phase 4 改动后,再走视觉验证
6. **Phase 5 端到端回归**:
   - **Step 5.1 cross-adapter spawn pair**(claude lead × codex reviewer-codex 端到端 + Round 1 review + 反驳轮 + Round 2):已在 Phase 0 Step 0.5 方向 A 实测 PASS — 本 Step 是真实端到端**回归**(装 Phase 1-4 改动后再跑一遍验证 SKILL.md / wrapper 删除 / build cp / UI 改动等不引入 regression)
   - **Step 5.2 codex lead 跨 adapter spawn reviewer-claude**:已在 Phase 0 Step 0.5 方向 B 实测 PASS — 本 Step 是真实端到端**回归**
   - **Step 5.3** codex CLI interactive `/agent-deck:deep-review` 触发**需 user 在 terminal 跑** (agent 跨进程跑不了 interactive shell, 落记录到 §当前进度 等 user 回来处理)
   - **Step 5.4 dormant 唤醒回归**: 跨 adapter reviewer 转 dormant 后被 lead `send_message` 唤醒,验证 spike 3 audit 结论在 cross-adapter 场景 work
   - **Step 5.5 资产面板 UI 回归**: 与 Step 4.3 真实视觉验证合并(同款验证步骤,Phase 5 阶段重 sweep 一次确保 Phase 1-4 任一改动不引 UI regression)
7. **Phase 6 收尾**:
   - 写 `changelog/CHANGELOG_X.md` (X 递增) 引用归档本 plan, 描述 cross-adapter native pair 改造 + 5 处 finding (fix v1/v2/v3 + phantom dep + ann openWorldHint) + Phase 1-4 改动总览
   - sweep 检查应用 CLAUDE.md / CODEX_AGENTS.md 是否还有遗漏 wrapper 描述 (Phase 1 已改基本完成,Phase 6 重 sweep)
   - 走 `mcp__agent-deck__archive_plan({plan_id, worktree_path, base_branch:'main', changelog_id:'X'})` 归档 (含 spike-reports/ 子目录自动归档到 `<main-repo>/plans/<plan_id>/spike-reports/`)
8. **主 repo working tree 清理** (user 决定时机, 与 plan v3 §下一会话第一步 同款):
   - 选项 A (推荐):先不动主 repo dirty,等 ff-merge worktree → main 时主 repo working tree 被 merge target 覆盖一致, 自然 clean
   - 选项 B:user 立即 `git -C /Users/apple/Repository/personal/agent-deck checkout package.json pnpm-lock.yaml` 撤回 (保留 node_modules `@modelcontextprotocol/sdk` symlink)。**注意**:不要跑 `pnpm install` 撤改动 — pnpm 会发现 main package.json 与 .pnpm 不一致, 可能清理 top-level symlink 让 dev mode 重新撞 phantom dep
9. **残留风险待实证** (Phase 5+ 视场景处理): codex CLI 对其他 `destructiveHint:true` tool (shutdown_session / archive_plan / exit_worktree / shutdown_baton_teammates) 是否也 cancel。本 plan SKILL.md 编排路径 (lead × reviewer 异构对偶) 不需要 codex SDK lead 自治调这类 tool — reviewer 由真 lead claude-code 调 shutdown_session 释放, 走 in-process transport 不受 codex CLI 决策影响。如未来场景需 codex SDK lead 自治 archive_plan 收口, 撞 cancel 时叠加修法选项 B (config 注入 `default_tools_approval_mode='always_allow'`, 代码改动 ≤ 5 行)
10. 在 §自主推进授权 下自己决定 hand-off 时机;进度 / 决策落 plan §当前进度 + commit 让 user 回来 cat 看完整脉络
11. 所有进度变更先告诉 user 征求确认 (仅当 user 在场时);离场期间自主推进
