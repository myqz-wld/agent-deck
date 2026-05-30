---
plan_id: "deep-review-and-asset-polish-20260530"
planId: "deep-review-and-asset-polish-20260530"
created_at: "2026-05-30T04:30:00+08:00"
worktree_path: "/Users/apple/Repository/personal/agent-deck/.claude/worktrees/deep-review-and-asset-polish-20260530"
worktreePath: "/Users/apple/Repository/personal/agent-deck/.claude/worktrees/deep-review-and-asset-polish-20260530"
status: "completed"
base_commit: "535d6e675813fee447672d45bb8ea7e876a46be1"
baseCommit: "535d6e675813fee447672d45bb8ea7e876a46be1"
base_branch: "main"
baseBranch: "main"
final_commit: "217bc57c5c0571872bedc733f5918aa9ced5e2f9"
completed_at: "2026-05-30"
---
# Plan: 近期大改动 deep review + 提示词/MCP/文档/图表资产优化

## 授权（用户 2026-05-30 明示，全程有效）

用户原话：「deep code review 下项目，主要是最近几次大改动。我要离开一会儿，**一路推进，自主决定 hand off 时机，这个授权写入到 plan 里**。」

→ **本 plan 全程授权 agent 自主推进**，无需逐 step confirm：
- ✅ 授权：worktree 内代码/文档/图表改动、`git commit`、跨会话 `hand_off_session`、最终 `archive_plan`、自主决定 hand-off / worktree / commit 时机
- ✅ 授权：deep-review SKILL 起 reviewer teammate、决策对抗起外部 CLI
- ❌ 不授权：`git push` 到 remote（保留给用户）、破坏性 git（`reset --hard` / force push / 删非本 plan 文件）、改 `~/.claude/.credentials.json` 等 OAuth
- ⚠️ autonomy 不豁免质量流程：HIGH finding 必修 / 决策对抗照走 / typecheck+build 必过才 commit

## 总目标（7 work streams）

| Phase | 目标 | 优先级 | 产出 |
|---|---|---|---|
| **A** | 最近几次大改动 deep code review（PRIMARY）| 最高 | REVIEW_68.md + HIGH/MED fix |
| **B** | UI polish（用户追加）：B1 日志按钮布局 + B2 UI 文案去实现细节/代码术语 + 术语统一（重点 Issues 面板）| 快速 | LogsSection.tsx / Issues 组件 / 其他 renderer 文案 |
| **C** | MCP tool description 优化（信息全面，防 LLM 传错参/意图偏差）| 高 | schemas.ts |
| **D** | arch-flow-plantuml SKILL 加到 codex 侧 + 资产能力对齐（用户追加）| 中 | codex plugin SKILL + refs |
| **E** | 提示词资产分层 + 优化（claude-config=通用 / 根 CLAUDE.md=项目特定）+ issue 工具章节 | 高 | CLAUDE.md / CODEX_AGENTS.md / reviewer bodies |
| **F** | 架构 / 流程图补充优化（issue-tracker + runtime-logging）| 中 | ref/flows + ref/architecture .puml |

### 最近"几次大改动"= deep review scope（Phase A）

按 git log 近期归档 plan，4 个大改动：
1. **issue-tracker-mcp-20260529**（最大新特性，主审）— report_issue / append_issue_context mcp tool + issue-repo + IPC + GC scheduler + Issues UI
2. **runtime-logging-electron-log-20260529** — electron-log v5 + 231 处 console.* → scoped logger + LogsSection UI（REVIEW_66 已抓 app.setName 副作用，审有无同类 init-order 隐患）
3. **mcp-tool-camelcase-migration-20260529** — 32 字段 snake_case → camelCase breaking change（审 handler 有无漏读 snake_case）
4. sdk-spawn-shell-path-20260529（较小，shell PATH 修复，spot-check 即可）

## 不变量（全程守约）

1. **质量流程不豁免**：Phase A 走 deep-review SKILL 多轮异构对抗；其余 phase 下结论/改 prompt 前走决策对抗（trivial 除外）
2. **提示词资产 5 硬约束**（user CLAUDE.md §提示词资产维护）：信息密度优先 / 当前事实不写兼容预测 / 可执行性>描述性 / 范围与失败兜底显式 / 示例克制。改完跑 5-step 自检
3. **分层原则**（用户 2026-05-30 明示）：`resources/claude-config/CLAUDE.md` = **通用约束**（所有项目 SDK 会话都加载，不得含 agent-deck 自身源码路径/REVIEW 引用等 codebase 内部细节）；根 `/agent-deck/CLAUDE.md` = **Agent Deck 项目特定约束**（design invariant / 打包 / 验证）。codex 侧 `CODEX_AGENTS.md` 与 claude-config/CLAUDE.md 大致对齐（adapter 差异措辞不强行对齐，详 README §设计 SSOT）
4. **代码改动不破坏现状**：typecheck + build 双过；改 main/preload 提醒重启 dev；vitest 相关改动跑全量 0 fail
5. **SSOT 单源不复制**：同款规则只在一处，其他位置 cross-ref（不抄全文）
6. **图表只生成/改 .puml SSOT 不渲染**（flow-arch SKILL §不渲染）；codex 端严禁 `plantuml -tpng/-tsvg`

## 设计决策（不再争论）

- **D1 worktree 隔离**：本 plan 跨多会话 + 多文件，走 worktree。base = 已 commit REVIEW_66/67 的 `535d6e6`，让 issue UI + 日志按钮工作建立在 REVIEW_67 修复之上而非 stale 文件（决策来源：避免 Phase B 重做 REVIEW_67 已修的 token）
- **D2 Phase A 用 deep-review SKILL**：用户要"deep code review"= 多轮异构对抗，正是 SKILL 用途。scope 大需分批（issue-tracker 一批 / runtime-logging 一批 / camelcase sanity 一批）
- **D3 Phase E 分层落地**：审 claude-config/CLAUDE.md §Agent Deck Universal Team Backend 等节内 agent-deck 源码路径引用（如 `src/main/.../recoverer.ts:103-220` / `schemas.ts` / `REVIEW_XX`）——这些是 codebase 内部细节，注入到**其他**项目会误导。处理：描述**能力**（工具行为）保留，删/泛化**实现引用**（源码路径行号）。纯"如何开发 agent-deck"的内容移到根 CLAUDE.md
- **D4 issue 章节落 claude-config**（通用能力，任何 Agent Deck 内项目可用，与 §Universal Team Backend 同级），codex 侧 CODEX_AGENTS.md 对齐
- **D5 schemas.ts 既是源码又是 prompt 资产**：tool description 注入 SDK system prompt → 适用提示词 5 约束；改完 typecheck 确认 TS 字符串未破坏
- **D6 phase 顺序** A→B→C→D→E→F：A 最优先且可能发现 bug 影响后续文档准确性；B 独立快速可插空（reviewer 后台跑时做）；C 在 E 前（issue 章节引用工具）；D 在 E 前（codex SKILL 文件须先存在才能更新引用）；E/F 大量动 CLAUDE.md/CODEX_AGENTS.md 须 D/E 协调避免反复 pass 同一大文件
- **D7 Phase D 方案 = 删 sync + 两端独立 SSOT（用户 2026-05-30 拍板，推翻原"加 codex 镜像"思路）**：用户原话「scripts/sync-codex-skills.mjs 可以去掉了，codex 和 claude 侧不同，还是直接写两份，而不是写一份再同步，其他提示词资产也一样」。
  - **决策对抗结论（双 reviewer 异构对抗）**：两 reviewer 一致**推荐方案 A（claude 单 SSOT + codex 镜像 + adapter-neutral 措辞）反对两端独立**（理由：flow-arch ~95% 是 adapter 无关 plantUML syntax，复制两份必漂移）。**lead 裁决尊重用户方案 C**，理由：flow-arch 交互/工具部分**确实 adapter 相关**（AskUserQuestion 阻塞 vs codex 自然语言 turn 边界，reviewer 自己 MED-2 承认；cross-ref CLAUDE.md vs CODEX_AGENTS.md 不同），用户"两端不同"抓住实质差异；方案 C 额外消除 sync 脚本+黑名单+gitignore+6 hook+installer 读错源 bug 一整套间接机制。syntax 漂移风险用"两端各自简单"对冲。**方案 C 可逆**（不满意回退重加 sync）。
  - **✅ HIGH（双 reviewer 独立 + 现场读码验证）**：`skills-installer.ts:56-61` 从 **claude-config** 读源 → codex runtime 一直装 flow-arch（claude 版坏流程）；sync 黑名单只挡资产面板镜像没挡 runtime（现状不一致 bug）。方案 C 删 sync 后**必须改 skills-installer sourceDir → codex-config**。
  - **方案 C 实施清单（7 组）**：
    - (A) 删 sync 机制：删 `scripts/sync-codex-skills.mjs` + `package.json` 删 6 处 sync hook（predev/prebuild/predist×4）+ `.gitignore` 删 L24-26 codex skills 忽略段
    - (B) codex skills 固化独立 SSOT：现有 codex deep-review/hello-from-deck（sync 生成，含 `{{AGENT_DECK_RESOURCES}}` 占位符 runtime substitute）入 git + 新建 codex 版 flow-arch-plantuml/SKILL.md（codex 适配：shell cat / apply_patch / 自然语言提问+turn 边界硬约束 / 引用 CODEX_AGENTS.md）
    - (C) 核心代码：`skills-installer.ts` getBuiltinSkillsSourceDir() claude-config → codex-config + 注释更新（bundled-assets.ts 已正确 dual-root 读 codex-config，不改）
    - (D) claude 端：claude 版 flow-arch SKILL.md 保持 claude builtin（两端独立无需 adapter-neutral）但删第 6 行 mirror 注释；deep-review/hello-from-deck claude 版同款 mirror 注释删；`CLAUDE.md:148`「codex 端走法」bullet 删/改（codex 现有独立 SKILL）
    - (E) `CODEX_AGENTS.md` 补 §核心流程必走 plantUML 节（完整 scope：触发 + 文件位置/INDEX + codex 确认机制 turn 边界 + 严禁静默生成图 baseline + 与 deep-review 互斥）
    - (F) `README.md` 改：删 sync 机制描述（L19）+ skills 改"两端独立 SSOT"（L26-29 删"codex 镜像"/"仅 claude 端"）+ §设计 SSOT 更新
    - (G) 验证：typecheck（skills-installer 改）+ 测试（bundled-assets-multi-root.test.ts / skills-installer 测试看是否受影响）+ CHANGELOG_X + commit
  - **历史引用不 retro 改**（reviewer INFO-3）：changelog/review/completed-plan 内"仅 claude 端"是冻结历史，只改 LIVE 资产（SKILL.md / CLAUDE.md / CODEX_AGENTS.md / README.md）

## Phase 分解 + checklist

### Phase A — Deep code review（PRIMARY）
- [ ] A1 — invoke `agent-deck:deep-review` kind=mixed，**批 1 = issue-tracker**：
  - `src/main/store/issue-repo.ts` (486L) / `src/main/store/migrations/v026_issues.sql` / `src/main/store/issue-lifecycle-scheduler.ts`
  - `src/main/agent-deck-mcp/tools/handlers/report-issue.ts` / `append-issue-context.ts`
  - `src/main/ipc/issues.ts`（commit 称 11 边界硬化，重点验）/ `src/preload/api/issues.ts` / `src/shared/types/issue.ts`
  - `src/renderer/stores/issues-store.ts` / `IssuesPanel.tsx` / `IssueDetail.tsx` / `ResolveInNewSessionDialog.tsx`
  - 审角度：source-bound（append 拒跨 session）/ resolved 拒 append / logsRef 合并(D17 date 覆盖+tsRange min-max+scopes union+note truncate) / soft-delete×GC 交互 / FK CASCADE / SQL 预编译 / event-changed 链
- [ ] A2 — **批 2 = runtime-logging**：`src/main/utils/logger.ts` / `src/renderer/utils/logger.ts` / `src/main/ipc/logs.ts` / `LogsSection.tsx` + logs preload/ipc-channels。审角度：init-order 副作用（REVIEW_66 app.setName 已知，找同类）/ console 接管不吞 stdout / NODE_ENV=test skip / fatal hook / rotation cleanup / IPC bridge。console→logger 231 处 spot-check 不全审
- [ ] A3 — **批 3 = camelcase sanity**：`schemas.ts` camelCase 字段 vs handler 读取一致性，grep 残留 snake_case 读取
- [ ] A4 — 三态裁决汇总 → 写 `ref/reviews/REVIEW_68.md` + 同步 INDEX
- [ ] A5 — 修 HIGH（必）+ MED（验证后）finding；typecheck+build 过；commit

### Phase B — UI polish（快速，Phase A reviewer 后台跑时可插空做）
- [ ] B1 — `LogsSection.tsx`：当前 3 按钮 2 行不平衡（截图反馈）。对齐项目按钮惯例（controls.tsx pill），布局更均衡（一行或合理分组）。HMR 验证
- [ ] B2 — UI 文案去实现细节/代码术语 + 术语统一（用户追加）：**重点 Issues 面板**（IssuesPanel/IssueDetail/ResolveInNewSessionDialog 暴露大量 db/code 术语：`sourceSessionId` / `cwd` / `logsRef` / `kind` / `deleted_at` / `handler 兜底 issue.cwd → homedir` / `D8 模板` / `agent 调 mcp tool report_issue` 等）。先探现有面板（SessionDetail / Team / Settings）文案风格与术语 → Issues 面板对齐、用户视角措辞、术语统一。其他 renderer 文案顺带扫
- [ ] B3 — typecheck + HMR 目视（无法目视的标注请用户确认）+ commit

### Phase C — MCP tool description 优化
- [ ] C1 — 通读 `src/main/agent-deck-mcp/tools/schemas.ts`(1386L) 全部 tool description + field description
- [ ] C2 — 决策对抗：哪些 description 易致 LLM 传错参/意图偏差（缺 required 说明 / 枚举值不全 / 默认值不清 / 互斥约束没写 / 单位/格式没写）
- [ ] C3 — 优化：信息全面 + 提示词 5 约束（删冗余降级/兼容长描述，保关键边界）。typecheck 确认 TS 未破坏。commit

### Phase D — 方案 C：删 sync + 两端独立 SSOT（✅ 完成 commit aaac005 / CHANGELOG_182；原 D1/D2/D3「加 codex 镜像」思路已被方案 C 推翻，详 §设计决策 D7 + §当前进度）
- [x] 方案 C A-H 八步全部完成（删 sync 机制 / skills-installer sourceDir / codex 3 skill 入 git / 新建 codex flow-arch / claude+codex 文档对齐 / 验证 typecheck+1089 test）

### Phase E — 提示词资产分层 + 优化（✅ 完成 commit 3388cec/CHANGELOG_183 + 01b4daf/CHANGELOG_184）
- [x] E1 — **分层审计**：claude-config/CLAUDE.md + CODEX_AGENTS.md + reviewer-claude.md 删 10 处 file:line 源码引用 + REVIEW_38 泛化 + R37 内部编号清理（保能力描述）
- [x] E2 — **§Issue 上报 章节**：两文件各加（report_issue/append_issue_context + source-bound/resolved/软删 + agent 只写不查；两端独立 SSOT）
- [x] E3 — **arch-flow 引用对齐**：复核确认 Phase D 已对齐，无「codex 无 SKILL」旧表述（无改动）
- [x] E4 — **通用优化 + codex 契约节 α**：5 约束自检（两文件约束 2/3/5 干净）+ Q3 决策对抗结论 α → CODEX_AGENTS.md 补 §决策对抗/§三态裁决/§Finding 输出契约（CHANGELOG_184）
- [x] E5 — reviewer body 过 5 约束（reviewer-claude.md 删 sandbox-config.ts 源码引用；两 body 约束 2 + 无残留源码路径自检通过）
- [x] E6 — 决策对抗（claude+codex 双外部 CLI + 三态裁决）+ CHANGELOG_183/184 + commit；纯 .md 无 TS delta typecheck N/A

### Phase F — 架构/流程图（✅ 完成 commit 217bc57/CHANGELOG_185；user AskUserQuestion 确认 scope）
- [x] F1 — issue-tracker 全套 4 张（flow + append 4 守门决策树 + 跨进程架构 + status×deleted_at 双轨状态机），落 ref/flows/ + ref/architecture/
- [x] F2 — runtime-logging 2 张（双进程 electron-log 架构 + console 接管/落盘/fatal sequence）
- [x] F3 — 复审：agent-deck-mcp-architecture 更新（15→17 tool / 4→5 数据表 / 加 issue 子图引用 + issueRepo 术语），其余图判 issue/logging 无关不动
- [x] F4 — sync ref/flows/INDEX.md + ref/architecture/INDEX.md（各 +3 行 + 更新 mcp-architecture 行）；plantuml -syntax 7 文件全过

## 当前进度（持续更新）

- ✅ commit REVIEW_66/67 baseline 到 main（`535d6e6`）
- ✅ 写 plan + 进 worktree（HEAD=535d6e6 clean）+ node_modules symlink
- ✅ **Phase B 完成**（commit `4aec0a9`）：日志按钮布局 + Issues 面板文案去术语 + cwd 必填误导 error。enum（open/in-progress/resolved 等）保留英文未翻译 — 待用户定夺
- 🟢 **Phase A batch-1（issue-tracker）已收口 + 已 commit（`2bd81af`）**：
  - 详见 `ref/reviews/REVIEW_68.md`（batch-1 节）：1 HIGH + 1 MED + 4 LOW（LOW-4 IssueDetail reactivity 修复尝试经异构 Round-2 推翻→回退降级）+ 6 INFO；0 残留 HIGH/MED
  - 改了：`ipc/issues.ts`（HIGH appendices 回填 + MED resolve race/guard）/ `issue-repo.ts`（LOW scopes dedup）/ `append-issue-context.ts`（LOW deletedAt 守门）。IssueDetail reactivity 已回退（保 fetched-baseline diff）
  - 异构对抗：reviewer-codex R1+R2 + reviewer-claude R1+R2（卡 8min 经 nudge 恢复）+ 外部 claude R2 合规兜底；典型案例：Fix-5 严重度两路分歧 → lead before/after 实证回退（详 REVIEW_68 §收口判定）
  - typecheck 过 + reviewer-codex R2 实跑 83 vitest 通过（issue-repo SQLite skip）
- ✅ **Phase A 完整收口 + 已 commit（`535dfd2`）**：batch 2/3 双 reviewer 异构对抗 R1+R2 收口
  - **batch 2（runtime-logging）**：3 MED（startCatching 默认配置改 fatal 语义→showDialog:!isPackaged + uncaughtException→app.exit(1) / 持久化 logLevel 启动不生效→bootstrap-infra 补 setFileLevel / truncate 绕过 electron-log File cache→getFile().clear()）+ 2 LOW（truncate 写回 / symlink）。console接管/init-order/NODE_ENV 双方判安全无 REVIEW_66 同类
  - **batch 3（camelcase sanity）**：lead 自查挖出 **HIGH**（migration 把 plan frontmatter 读取误迁 camelCase 但 plan 文件写 snake → hand_off 硬拒/archive cross-check 静默失效/base_branch 错合主线）→ revert 8 处读取 + 8 测试文件 fixture masking + 3 regression；**MED** description drift 7 处（claude R2 抓 2 + lead grep 扩展 5）→ snake
  - **异构价值**：codex R2 捞出 lead 漏修 logLevel MED，claude R2 捞出 lead 漏修 description drift MED，各补一个首轮遗漏
  - typecheck 清 + 全量 1089 passed / 197 skipped + build OK；REVIEW_68 + INDEX 更新；reviewer pair 已 shutdown
  - **Phase A follow-up（CI/下会话）**：logLevel startup regression test（bootstrap-infra 无 harness，deferral）+ logs IPC 测试覆盖（INFO）
- ✅ **Phase C 完成 + 已 commit（`cf6d2f9`）**：agent-deck-mcp 17 tool description 优化（CHANGELOG_181）。决策对抗外部 claude+codex 各独立审 schemas.ts/index.ts → 三态裁决去重 → 修 drift（callerSessionId required / reply-wait 已删工具 / task status enum / teamId null / hand_off teamName 过时 / activeForm / archive cwd）+ 补缺失（spawn adapter/cwd/prompt/teamName 零 describe / enter_worktree 不改 cwd / list teams[] / task_update 数组替换 / logsRef date）+ 信息密度（strip 8 内部编号前缀 / tool count 15→17）。typecheck 清 + 全量 1089 passed。**Phase C follow-up**：hand_off/archive 长 desc 瘦身 + activeForm 代码级 dual-usage（assignee vs UI 进行时）需单独裁决
- ✅ **Phase D 完成（方案 C：删 sync + 两端独立 SSOT，commit `aaac005` / CHANGELOG_182）**：
  - **方案演进**：原 Phase D = "加 codex flow-arch 镜像"；用户 2026-05-30 拍板推翻为删 `scripts/sync-codex-skills.mjs` + claude/codex 两端各写独立 SSOT（详 §设计决策 D7）。决策对抗已在 plan 阶段完成
  - **实施（A-H 八步）**：(A) 删 sync 脚本 + package.json 6 hook + .gitignore 忽略段 / (B) skills-installer `getBuiltinSkillsSourceDir` claude-config→codex-config（**修 codex runtime 装 claude 版 flow-arch HIGH bug**）+ jsdoc / (C) codex deep-review 删 mirror 注释 + L217 去 home `user CLAUDE.md` leak 改 repo 路径 + hello-from-deck 直接入 git（保留占位符）/ (D) 新建 codex flow-arch SKILL（shell cat/apply_patch + turn 边界硬约束 + cross-ref CODEX_AGENTS.md + 严禁渲染）/ (E) claude deep-review+flow-arch 删 mirror 注释 + CLAUDE.md codex 走法 bullet 改写 / (F) CODEX_AGENTS.md 补 §核心流程必走 plantUML 节 / (G) claude-config/README.md 两端独立 SSOT / (H) 验证
  - **验证**：typecheck 清 + 全量 1089 passed/197 skipped（与 Phase A 一致 0 回归）；bundled-assets dual-root 确认从 codex-config 读（资产面板将显示 3 个 codex skill 含新 flow-arch）；multi-root test 用 fixture 独立不依赖 sync；无 skills-installer 单元测试无需清理
  - **codex 化决策记录**：deep-review SKILL 已高度 adapter-neutral（L12/L135/L205 双 adapter 双写），仅 2 处 claude leak 微调（mirror 注释 + home 文件引用）；L122/L199 引用 repo `claude-config/CLAUDE.md`（契约真实 SSOT，§不变量 5 不复制）保留
  - ⚠️ **Phase E 关注点（D 阶段发现）**：codex 端 CODEX_AGENTS.md 缺 §决策对抗 / §三态裁决 / §Finding 输出契约 节（codex deep-review SKILL L122/L199/L217 完整契约引用 claude-config repo 文件，dev 可 cat 但打包路径别扭）→ E 阶段评估是否补 codex 端契约节 / 或确认引用策略
- ✅ **Phase E 完成（commit `3388cec`/CHANGELOG_183 核心 + `01b4daf`/CHANGELOG_184 codex 契约节 α）**：
  - **E1 分层审计**：claude-config/CLAUDE.md + CODEX_AGENTS.md + reviewer-claude.md 删 10 处 agent-deck 源码 `file:line` 引用（recoverer.ts:103-220 / schemas.ts / hand-off-session.ts:21-39 / types.ts EXTERNAL_CALLER_ALLOWED / sandbox-config.ts:92-110，能力描述全保留）+ REVIEW_38 追溯泛化 + recoverer.ts 示例 → worker.ts + R37/Phase C 内部编号清理。**plan E1 清单漏列项已补**：CODEX_AGENTS.md types.ts EXTERNAL_CALLER_ALLOWED
  - **E2 §Issue 上报 章节**：两文件末尾各加（与 §Universal Team Backend 同级，两端独立 SSOT）：何时上报 5 类 kind / report_issue 字段表 / append source-bound + resolved/软删 拒 / agent 只写不查
  - **E3**：复核确认 Phase D 已对齐 codex flow-arch SKILL 引用，无「codex 无 SKILL」旧表述（无改动）
  - **E4 + codex 契约节 α**：5 约束自检（两文件约束 2/3/5 干净）；Q3 决策对抗（claude Opus 4.7 + codex 双外部 CLI 异构）**双 reviewer 一致裁决 α** → CODEX_AGENTS.md 补 codex 风格 §决策对抗/§三态裁决/§Finding 输出契约（双 shell / shell &+wait 并发 / read-only flag 引模板 / 无 timeout 命令体）+ 4 处 cross-ref（codex SKILL:120/197/215 + reviewer-codex:80）改指向 CODEX_AGENTS.md baseline（修 codex 决策对抗零覆盖 + 断链）
  - **E5**：reviewer-claude.md 删 sandbox-config.ts 源码引用；两 body 约束自检通过
  - **决策对抗（CHANGELOG_183 Q1-Q4 三态裁决）**：✅ Q1 §Issue 上报准确性（**返回 IssueRecord 主键是 `id` 非 `issueId`**，否则 agent `result.issueId` undefined → append 失败；双 reviewer + 现场验证 issue.ts:79+handler+test）/ 补软删 reject / logsRef date 始终必填；✅ Q4 删 CODEX_AGENTS future 预测「reassignOwner 目前未实现」
  - 纯 .md 资产改动无 TS delta（typecheck N/A，未碰 schemas.ts）；reviewer 总判「本 diff 正确零过头、无 HIGH/MED 引入、Phase E 可合」
  - **Phase E follow-up（issue `90221cb8` convention-gap）**：① **F5 广义内部名残留清理**（双 reviewer HIGH grep 实证，pre-existing）：两文件仍含 class.method（sessionRepo.delete/sessionManager.close/runBatonCleanup 等）+ 内部编号（N5/N2.c/D1 ADR）+ DB 列名纯实现符号，需 careful pass 按「运行环境概念保留 vs 纯实现符号删」判则 ② claude-config §决策对抗「claude 用 --permission-mode plan」与模板实际「default + disallowedTools ExitPlanMode」矛盾（pre-existing doc bug）③ CODEX_AGENTS.md:213/235 §复杂 plan workflow §Step4 §中止 cross-ref codex 读不到（大节不照搬，评估改 cross-ref 措辞 vs inline 5 步）
- ✅ **Phase F 完成（commit `217bc57`/CHANGELOG_185；user AskUserQuestion 确认 scope = issue-tracker 全套 4 张 + runtime-logging 2 张）**：
  - F1 issue-tracker 4 张（ref/flows/issue-tracker-flow + issue-tracker-append-decision；ref/architecture/issue-tracker-architecture + issue-tracker-state-machine）；画前读 issue.ts/v026 migration/issue-repo/scheduler/ipc/append-handler 对齐
  - F2 runtime-logging 2 张（ref/architecture/runtime-logging-architecture + ref/flows/runtime-logging-flow）；画前读 main+renderer logger / ipc/logs 对齐
  - F3 复审：agent-deck-mcp-architecture 更新（15→17 tool ×3 + 4→5 数据表 node+edge + issue 子图引用 + issueRepo 术语）；其余 8 flow+7 arch 判 issue/logging 正交无失真不动（topic backdrop 计数 / console.warn 行为说明保留）
  - F4 两 INDEX 各 +3 行；`plantuml -syntax`（非渲染）7 文件全过 0 错误；只生成 .puml SSOT 不渲染
- ✅ **plan 全部 Phase A-F 收口，可 archive_plan（base_branch=main，ff-merge 可行已验，worktree clean）**


### batch-1 遗留（下会话/CI）
1. ⚠️ 为 4 处 fix 补回归 test case（resolve entry-guard/re-read、update appendices 回填、append deletedAt reject、scopes dedup overflow）；issue-repo SQLite 测试需按 CHANGELOG_42 binding 流程跑
2. ⚠️ main 改动需重启 dev 实测；LOW-4 reactivity follow-up（正确修法=独立 diff baseline，需 live 浏览器）
3. enum 中文化（Phase B 遗留）待用户定夺

## 下一会话第一步（Phase F 架构/流程图，须先 user 确认；Phase A-E 已收口）

> ⚠️ Phase A/B/C/D/E 全部收口（最新 commit `01b4daf`=HEAD）。**仅剩 Phase F**（架构/流程图）—— flow-arch-plantuml SKILL **硬约束必先与 user AskUserQuestion 确认核心变更**，不能 autonomous 静默生成图（plan step 3 + SKILL baseline）。worktree HEAD=01b4daf clean。

1. `Bash: cat /Users/apple/Repository/personal/agent-deck/.claude/plans/deep-review-and-asset-polish-20260530.md` 读全文（重点 §当前进度 Phase E 完成 + §Phase F checklist）
2. `EnterWorktree(path: "/Users/apple/Repository/personal/agent-deck/.claude/worktrees/deep-review-and-asset-polish-20260530")` + `Bash: pwd` 自检 + `git -C <worktree> log --oneline -6`（HEAD=01b4daf clean）
   - ⚠️ worktree node_modules 是 symlink，typecheck/build 可跑；SQLite vitest ABI skip
3. **Phase F**（架构/流程图）：invoke `agent-deck:flow-arch-plantuml` SKILL → **SKILL 入口先 AskUserQuestion 与 user 对齐**（是否核心变更 / 图类型 / 新建 vs 修改 vs archived 已有）；user 确认后只生成/改 `.puml` SSOT **不渲染**（严禁 plantuml -tpng/-tsvg）：
   - **F1 issue-tracker**：flow（report_issue→issue-repo→event-changed→UI；append source-bound；GC scheduler）落 `ref/flows/` + architecture（mcp tool/ipc/repo/scheduler/renderer store 跨进程边界）落 `ref/architecture/`
   - **F2 runtime-logging**：architecture（main+renderer logger 双进程 / console 接管 / IPC bridge / rotation）落 `ref/architecture/`
   - **F3** 复审现有 9 flow + 8 arch 图有无因 issue-tracker/runtime-logging 改动失真，按需更新
   - **F4** sync `ref/flows/INDEX.md` + `ref/architecture/INDEX.md`（4 列表）
4. **收口**：Phase F 完成后 `archive_plan({planId, worktreePath, baseBranch:"main"})`（先 `ExitWorktree(action:"keep")`；本 plan 无 spike-reports）
5. **Phase E follow-up（issue `90221cb8` convention-gap，不阻断收口）**：① **F5 广义内部名残留清理**（双 reviewer HIGH grep 实证 pre-existing；按「运行环境概念保留 vs 纯实现符号删」careful pass）② claude-config §决策对抗「--permission-mode plan」与模板 default 矛盾（doc bug）③ CODEX_AGENTS.md:213/235 §复杂 plan workflow §Step4 §中止 cross-ref codex 读不到（评估改措辞 vs inline 5 步）。转独立 follow-up plan 或留 issue 跟踪
6. **更早遗留**：batch-1 4 处 fix 补回归 test（issue-repo SQLite 按 CHANGELOG_42 binding 流程）/ enum 中文化待 user 定夺 / LOW-4 IssueDetail reactivity（需 live 浏览器）/ Phase A logLevel startup regression test + logs IPC 测试 / Phase C hand_off/archive 长 desc 瘦身
7. autonomy 全程授权（user 2026-05-30，含 hand_off/commit/archive_plan）；**唯 Phase F flow-arch 须 user AskUserQuestion 确认**（plan step 3 + SKILL 硬约束）；所有代码资产路径加 worktree 前缀；进度/设计变更先告知用户
8. ⚠️ **可能 malformed 报错**：工具调用后或现 "Your tool call was malformed and could not be parsed" 但工具**实际成功**（harness quirk）；看工具结果是否成功即可，不要重试已成功的调用

## 已知踩坑

- **worktree 路径前缀**：进 worktree 后所有代码资产路径（Read/Edit/Grep/Bash 绝对路径/git -C）必须含 `.claude/worktrees/deep-review-and-asset-polish-20260530/` 前缀；plan 文件本身在 main repo `.claude/plans/` 不加前缀。进 worktree 先 `pwd` 自检
- **REVIEW_66 教训**：logger.ts `app.setName` 改 userData 目录——审 logging 时找同类 module-init 副作用
- **camelcase breaking**：handler 读参数应全 camelCase；grep snake_case 读取找漏网
- **schemas.ts 是 TS 源码**：改 description 字符串注意转义/引号，改完必 typecheck
- **codex/claude SSOT 不强行对齐**：adapter 机制差异措辞不同是设计意图（README §设计 SSOT），不要为"对齐"制造 drift
- **archive_plan baseBranch**：本 plan base_branch=main，收口 ff-merge 回 main
