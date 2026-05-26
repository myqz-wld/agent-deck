---
plan_id: mcp-handoff-fix-and-skill-timer-20260514
created_at: 2026-05-14
worktree_path: /Users/apple/Repository/personal/agent-deck/.claude/worktrees/mcp-handoff-fix-and-skill-timer-20260514
status: completed
base_commit: 5db9844
base_branch: main
final_commit: 4723fe5
completed_at: 2026-05-14
---

# mcp hand-off fix + SKILL timer + 文档大整理（R1 deep review 4 HIGH + 8 MED + 用户 3 件事）

## 总目标 & 不变量

**目标**：一次性收口 R1 deep code review 挖出的 4 HIGH + 8 MED 真问题 + 用户提的 3 件事（hand-off bug 1 / hand-off 文档触发缺失 / check_reply 定时 fallback），让 mcp tool 真实行为、文档、SKILL 三者重新对齐。

**触发**：用户跑 deep-code-review SKILL 审 5 份核心文档（SKILL.md / reviewer-{claude,codex}.md / ~/.claude/CLAUDE.md / resources/claude-config/CLAUDE.md），R1 双 reviewer 独立挖 14+11=25 finding；用户额外报「start_next_session 调用报错」+「lead 不会自动 hand off」；lead 看到 reviewer-claude 现场验证 `mcp__agent-deck__*` 连字符 vs 文档下划线 → 决定走 §复杂 plan 流程。

**不变量**（实施过程任何时候不能破）：
1. 异构对抗机制不破：不让 reviewer-claude 跑 codex 那侧 review，不让 reviewer-codex 跑 claude 那侧 review
2. SKILL 主路径 user-driven check_reply 不破：timer 是**兜底**叠加，不取代 user 主动介入路径
3. `process.cwd()` 修复要兼容 test inject 模式：现有 archive-plan / start-next-session 单测 deps inject 接口稳定不动
4. 5 份文档 SSOT 划分不破：通用约定在 user CLAUDE.md / 应用差异在 app CLAUDE.md / SKILL 自己 / reviewer 协议 / 真实底层协议 docs/agent-deck-mcp-protocol.md 各管一摊
5. teammate 协议不破：wire format 注入 + reply_message regex 抓 messageId 不动，wait_reply nudge 死锁的修法只动后端不动协议

**review reviewer 处理**：保留 alive 等 R2，**不 shutdown**（teammate 持久化优势）。idle 期间 0 token 消耗。
- reviewer-claude session: `1be5fb2a-4baf-4314-a3c7-c76f6fa3d98d`
- reviewer-codex session: `2f712dad-5366-4651-9338-3f2e7a315cc0`
- team: `skill-doc-review` (`6c080133-0aec-4dff-a271-f289f24dbee1`)

---

## 设计决策（不再争论）

### D1. caller cwd 修法：handler 层从 sessionRepo 反查注入 implDeps，不动 impl 接口
- handler 拿 `ctx.caller.callerSessionId` → `sessionRepo.getSessionRow(sid)?.cwd` → 注入 `implDeps.cwd = () => row.cwd`（无 row / external caller fallback `process.cwd()` 保留兼容性）
- impl 层 deps 接口完全不动；现有 5 处 archive-plan / start-next-session test 不受影响
- 同款修 `start-next-session.ts` + `archive-plan.ts` 两个 handler

### D2. wait_reply nudge 死锁修法：后端双查 + 返回 nudgeMessageIds
- wait.ts 内 nudge enqueue 时把 nudgeMessageId 暂存到 wait 闭包；resolve 路径 `findRepliesByMessageId(originalId).concat(nudgeIds.flatMap(findRepliesByMessageId))` 双查
- 返回 schema 加 `nudgeMessageIds: string[]` 字段（doc 提示 caller 自检）
- **不**改 wire format（不破 reviewer 协议）
- 同时也把 wait_reply tool description 里 `nudge_text + nudge_after_ms` 描述更新（标注「内部已修双查死锁」）

### D3. tool name 统一为 `mcp__agent-deck__*`（连字符）
- 改 server.ts `AGENT_DECK_MCP_TOOL_PATTERN` 为 `'mcp__agent-deck__*'`（让 allowedTools 真生效）
- 5 份文档 + docs/agent-deck-mcp-protocol.md + README + 历史 changelog（仅引用句改）全部改成连字符
- 不改 server `name: 'agent-deck'`（已是连字符）和 mcpServers key（已是 'agent-deck'），保留低成本路线

### D4. hand-off 触发条件：加在 user CLAUDE.md（不放 SKILL.md）
- user CLAUDE.md 是「单会话 agent 自检」的源头文档，hand-off 触发是 agent 行为约束，不是 SKILL 行为
- 在「§Step 3 接力姿势」前面加「§Step 2.5 何时主动 hand off（lead 自检触发）」节
- 触发条件分客观信号 / 用户语义信号两类，命中即必须主动调 K2（§选项 B）

### D5. SKILL check_reply timer fallback：用 CronCreate session-only 周期 prompt，不加 ScheduleWakeup
- ScheduleWakeup 限 /loop dynamic mode，本场景不适用
- CronCreate `recurring: true, durable: false` 起 session-only 周期 prompt（lead context 重置后自动消亡）
- 周期 7-10min，避开 :00/:30（用如 `7,17,27,37,47,57 * * * *` 形态）
- 收到 reply / 进入 fix 阶段 / shutdown 时 `CronDelete` 清理
- SKILL.md 那段「严禁 wait_reply / ScheduleWakeup / Bash sleep」澄清边界：禁阻塞型 timer，CronCreate 非阻塞 fire-then-prompt OK

### D6. 大改 docs/agent-deck-mcp-protocol.md 还是降级为 stub
- 选**降级为 stub**：保留文件但内容缩成「真实规范见 SKILL.md / reviewer-*.md / app CLAUDE.md / src/main/agent-deck-mcp/tools/schemas.ts」+ 一段「为什么不维护完整版」原因说明
- 理由：完整协议会跟 5 份 doc 长期漂移；schemas.ts 才是 SSOT；维护成本高收益低

### D7. abandoned plan 在 archive_plan 的处理（M7）：实现侧加显式拒绝
- 当前 archive-plan-impl.ts 只拒 completed，abandoned 会被静默继续 merge/mv/commit
- 加显式 `if (status !== 'in_progress') return error`（同 start-next-session-impl.ts 第 178 行模式）
- 文档（user CLAUDE.md §Step 4）已经说「中止 不走 archive_plan」，加实现侧防御对齐文档

### D8. shutdown_session 不删数据列表补 messages（M1）+ team_member 软退出 / spawn_link 全保留（LOW4）
- shutdown.ts 注释 + schemas.ts tool description（这是 system prompt 看到的版本）一并补
- 应用 CLAUDE.md L38 末尾补 team_member / spawn_link 备注

### D9. 其他 MED/LOW 一次性改：M2 / M3 / M5 / M6 / M8 + LOW 顺手能改的
- M2 archive 无条件：app CLAUDE.md + start-next-session.ts 注释澄清
- M3 xhigh 误标：SKILL.md 改成「Opus 4.7 default thinking」
- M5 wire id invariant：reviewer-{claude,codex}.md 加一行 invariant 锚定
- M6 NO MSG ANCHOR fallback：reviewer-{claude,codex}.md 改成「无 anchor 时退化裸 message reply（不传 reply_to_message_id）+ 警告 lead 该 reply 不进 wait_reply 流程」
- M8 mktemp $TMPDIR：~/.claude/templates/reviewer-{claude,codex}.sh.tmpl 同步成 $TMPDIR 形式

### D10. R2 验证策略
- send_message 让两个 reviewer 复用 mental model
- prompt 模式 = `output_mode: full_review`，scope 缩成「fix 涉及文件清单 + git diff <base_commit>..HEAD」
- skip 字段列上轮已确认 ✅ 的 fix 摘要（按格式 `已修：<filepath:line> <一句话改动> (commit <hash>)`，对应 LOW2 修复格式）

---

## 步骤 checklist（4 phase × 多 step）

### Phase A — 代码修复（HIGH 优先级）

- [x] **A1. caller cwd bug 修（H5，handler 注入 callerSessionCwd 给 implDeps）** — done by sid `ad0a1658-1e06-4757-a9f2-2344ef6185e7` on 2026-05-14, commit `438a613`. start_next_session + archive_plan 同款修，sessionRepo 反查；2 个 caller-cwd test 全过
- [x] **A2. wait_reply nudge 死锁修（H2）** — done by sid `ad0a1658` on 2026-05-14, commit `438a613`. wait.ts 闭包收 nudgeMessageIds + 双查 + ok return 加字段；schemas.ts wait_reply nudge_text desc 同步澄清
- [x] **A3. tool name pattern 修（H1）** — done by sid `ad0a1658` on 2026-05-14, commit `438a613`. server.ts pattern 改连字符；41 处 src+docs+resources 文档批量替换；translate.test.ts fixture 字符串与 agent-deck 无关保留
- [x] **A4. abandoned plan 拒绝（M7+D7）** — done by sid `ad0a1658` on 2026-05-14, commit `438a613`. archive-plan-impl.ts 加 abandoned + 缺失/非法 status 拒绝；test 加 2 case
- [x] **A5. start_next_session ok return 加 `archived` 字段（未验证 #1 升级）** — done by sid `ad0a1658` on 2026-05-14, commit `438a613`. start-next-session.ts archive 路径补 'ok'|'failed'|'skipped' 三态返回
- [x] **A6. shutdown.ts 注释补 messages（M1+D8）** — done by sid `ad0a1658` on 2026-05-14, commit `438a613`. shutdown.ts 文件头注释 + tools/index.ts shutdown_session description 同步补全（messages / team_member / spawn_link）
- [x] **A7. typecheck + 跑 test** — done by sid `ad0a1658` on 2026-05-14. pnpm typecheck pass / 90 mcp test 全过（2 file，含 4 个新 case）

### Phase B — 文档大改（HIGH + 一致性 + 三件事）

- [x] **B1. docs/agent-deck-mcp-protocol.md 降级 stub（H3+D6）** — done by sid `<this-sid>` on 2026-05-14, commit `0cc4f79`. 729 行 ADR → 30 行 stub + 真实 SSOT 路径表
- [x] **B2. 跨会话救火加 shared-team 前置（H4）** — done by sid `<this-sid>` on 2026-05-14, commit `0cc4f79`. 应用 CLAUDE.md §跨会话救火 节加 callout，列同 caller / 跨 caller 三种续接姿势
- [x] **B3. user CLAUDE.md 加「§Step 2.5 何时主动 hand off」（H6+D4）** — done by sid `<this-sid>` on 2026-05-14, commit `0cc4f79` (worktree 改) + user home 直改 `/Users/apple/.claude/CLAUDE.md`. 新节客观信号 + 用户语义信号 + 例外
- [x] **B4. SKILL.md 加 timer fallback + 边界澄清（M4+D5+用户三件事 #3）** — done by sid `<this-sid>` on 2026-05-14, commit `0cc4f79`. Step 2 「严禁」清单调整 (阻塞 vs 非阻塞)；新增 §timer fallback 子节 (CronCreate recurring durable:false / 7-10min / CronDelete 三时机)
- [x] **B5. tool name 5 份文档全改连字符（H1）** — done by sid `<this-sid>` on 2026-05-14. user home `~/.claude/CLAUDE.md` 4 处替换；模板未涉及 mcp tool name 跳过；worktree 内文档已在 A3 批量改完
- [x] **B6. wait_reply nudge_text 文档同步（H2 配套）** — done by sid `<this-sid>` on 2026-05-14, commit `0cc4f79`. 应用 CLAUDE.md §wait_reply 节 ok return shape 加 `nudgeMessageIds` + 加 nudge 死锁修复说明段
- [x] **B7. start_next_session archive 无条件澄清（M2）** — done by sid `<this-sid>` on 2026-05-14, commit `0cc4f79`. 应用 CLAUDE.md K2 节 result shape 补 `archived: 'ok'|'failed'|'skipped'` + 加 archive 无条件原则 callout
- [x] **B8. SKILL.md xhigh 误标修（M3）** — done by sid `<this-sid>` on 2026-05-14, commit `0cc4f79`. 仅改 reviewer-claude（Opus 4.7 default thinking），reviewer-codex 那侧 gpt-5.5 xhigh 是真保留
- [x] **B9. wire format id invariant（M5）** — done by sid `<this-sid>` on 2026-05-14, commit `0cc4f79`. reviewer-{claude,codex}.md §核心纪律 reply 子条加 invariant：crypto.randomUUID v4 lowercase hex+hyphen / charset [0-9a-f-]{36} / 同步范围
- [x] **B10. NO MSG ANCHOR fallback 完整化（M6）** — done by sid `<this-sid>` on 2026-05-14, commit `0cc4f79`. 退化路径分三段：send_message 不传 reply_to_message_id + list_sessions 反查 lead session_id + 最终兜底落 SDK assistant output
- [x] **B11. ~/.claude/templates/reviewer-{claude,codex}.sh.tmpl 同步 $TMPDIR（M8）** — done by sid `<this-sid>` on 2026-05-14. 两个 .tmpl 改 `mktemp "${TMPDIR:-/tmp}/<prefix>.XXXXXX"` + 注释加 sandbox 解释 (改的是 user home 不在 worktree commit)
- [x] **B12. shutdown 不删数据列表补全（M1+D8 文档侧）** — done by sid `<this-sid>` on 2026-05-14, commit `0cc4f79`. 应用 CLAUDE.md L38 messages 已在 + 补「team_member 通过 left_at 软退出」「spawn_link 全保留」备注
- [x] **B13. LOW + INFO 顺手批量改** — done by sid `<this-sid>` on 2026-05-14, commit `0cc4f79`. SKILL.md 「10 个 tool」→ 「5-6 核心 + 4-5 救火」/ 「6 步」→「7 步」/ Step 5 加 skip 格式示例 / app CLAUDE.md §Agent Teams stale ref 改写 + L37 send replyToMessageId 加「首条 null」+ L56 stub 配套改 / README mcp 7→10 tool 2 处 / reviewer-codex.md mktemp 注释加 sandbox profile 解释
- [x] **B14. dormant ≠ 丢 mental model 反直觉踩坑沉淀到 3 处 md（user 反馈）** — done by sid `<this-sid>` on 2026-05-14, commit `58a5db9`. spawn R2 reviewer 时我误推理 dormant = fresh = 必须 spawn → user 提醒 SDK resume → 验证 recoverer.ts:103-220 + 补 callout 到 app CLAUDE.md / SKILL.md / reviewer-{claude,codex}.md

### Phase C — R2 验证 fix（双 reviewer 复用 mental model）

- [x] **C0 list_sessions 检查 + 决定 R2 起手** — done by sid `b507afc4` on 2026-05-14. 旧 reviewer dormant；当时误推理 dormant=fresh 决定 spawn 新一对（B14 后纠正）
- [x] **C1 spawn 新一对 reviewer + 发 R2 prompt** — done by sid `b507afc4` on 2026-05-14. team `r2-validate-mcp-handoff-fix` (`c0faee14`); reviewer-claude `7abbd920` + reviewer-codex `0b2fe5c3`
- [x] **C2 user-driven check_reply poll 等 R2 reply** — done. 双 reply 都在 5-10min 内到
- [x] **C3 R2 三态裁决** — done. 双方一致「fix 部分通过 + 列残留 — 暂不可合」：1 HIGH (K2 baton spawn_depth) + 4 MED + 3 LOW + 1 *未验证* (codex namespace, follow-up)
- [x] **C5 R3 send_message 双 reviewer (复用 R2 mental model)** — done by sid `b507afc4` on 2026-05-14. 直接 send_message 给 active 的 reviewer (不必新 spawn / 不必等 dormant resume)；R3 prompt skip 字段列 commit `4d48ef0` 完整 fix 摘要
- [x] **C5b 等 R3 双 reply** — done. claude messageId `1c26f1a6` reply `62210292`；codex messageId `9d83fe06` reply `5e71a393`
- [x] **C6 R3 三态裁决：双 reviewer 一致「全部 R2 finding fix 对症 + 0 引新 bug + 可合 (R3 收口)」** — done
- [x] **C7 shutdown_session × 2 reviewer** — done. lifecycle 'closed'，events / messages 子表保留供裁决报告引用

### Phase D — 收口 + hand off

- [x] **D1. typecheck + build smoke** — `pnpm typecheck` + `pnpm build` 全过
- [x] **D2. 写 changelog** — `<worktree>/changelog/CHANGELOG_98.md` + 同步 `changelog/INDEX.md` (X=97 → X=98)
- [ ] **D3. commit changelog + plan 最终更新 + ExitWorktree(action: "keep")**
- [ ] **D4. mcp__agent-deck__archive_plan 自动归档** — H5 已修，可用 K1 mcp tool
- [ ] **D5. 用户验证打包后行为正常**（可选，按用户决定）

---

## 当前进度

- ✅ R1 deep review 完成（25 finding 三态裁决完毕）
- ✅ Phase 0：进 worktree + 写 plan
- ✅ Phase A：7 step 全完，commit `438a613`，typecheck + 90 mcp test 全过
- ✅ Phase B：13 step 全完，commit `0cc4f79`，typecheck pass（文档 only）
- ✅ B14 dormant 反直觉踩坑沉淀 3 处 md，commit `58a5db9`
- ✅ Phase C R2 反馈 1 HIGH + 4 MED + 4 LOW（双 reviewer 一致裁决「不可合」）
- ✅ Phase E + F 一批修完 1 HIGH + 4 MED + 3 LOW + 8 case test，commit `4d48ef0`，typecheck + build + 98 mcp test 全过
- ✅ Phase C R3：双 reviewer 一致「全部 R2 finding fix 对症 + 0 引新 bug + 可合 (R3 收口)」
- ✅ Phase D D1 typecheck + build + D2 CHANGELOG_98.md + INDEX.md 同步
- ⏳ 下一步：**D3 commit changelog + plan 最终更新 + ExitWorktree → D4 archive_plan tool**

## 下一会话第一步

按 plan 进入 worktree（`EnterWorktree(path: "/Users/apple/Repository/personal/agent-deck/.claude/worktrees/mcp-handoff-fix-and-skill-timer-20260514")`）→ 找 plan checklist 下一个未勾 step（**B1**）→ 直接动手。

**Phase B 起手清单**（按顺序做，每改一组 commit 一次）：

1. **B1**：把 `<worktree>/docs/agent-deck-mcp-protocol.md` 完整改成 stub（保留文件名，内容缩成 ~30 行：标题 + 1 段「为什么不维护完整版」+ 真实 SSOT 路径列表 → SKILL.md / reviewer-{claude,codex}.md / app CLAUDE.md / src/main/agent-deck-mcp/tools/schemas.ts）
2. **B2**：`<worktree>/resources/claude-config/CLAUDE.md` §跨会话救火 节加 callout（shared-team 前置）
3. **B3** ⚠️ **改的是 user home（不在 worktree）**：`/Users/apple/.claude/CLAUDE.md` 在 §复杂 plan 内插入新子节「§Step 2.5 何时主动 hand off（lead 自检触发）」。触发条件：context ≥ 60% / 完成独立 phase / worktree 干净 / plan 已写好下一步 + 用户语义信号「告一段落 / 先停一下 / 累了 / 先这样」；命中即默认走 §选项 B（K2 baton），plan 未填好 / worktree dirty 是例外
4. **B4**：`<worktree>/resources/claude-config/agent-deck-plugin/skills/deep-code-review/SKILL.md` Step 2 加「§timer fallback」分节（CronCreate `recurring: true, durable: false` 周期 7-10min 兜底；收到 reply / fix / shutdown 时 CronDelete；保留 user-driven 主路径不变） + 改写「为什么 user-driven 而非 wait_reply / ScheduleWakeup」段澄清「禁阻塞型 timer，CronCreate 非阻塞 fire-then-prompt OK」
5. **B5**：tool name 5 份文档已在 Phase A3 批量改完连字符 → ⚠️ **但 user CLAUDE.md 不在 worktree**，需要顺手在 B3 同会话改 `~/.claude/CLAUDE.md` 同款替换（`mcp__agent_deck__` → `mcp__agent-deck__`，3 处），同时 `~/.claude/templates/reviewer-{claude,codex}.sh.tmpl` 也改（B11 配套）
6. **B6**：`<worktree>/resources/claude-config/CLAUDE.md` L46 wait_reply 字段说明加注「nudge 内部已自动双查（A2 修），返回 `nudgeMessageIds: string[]` caller 可旁路 check_reply 自检」
7. **B7**：archive 无条件 (M2) — start-next-session.ts 注释已在 A5 间接覆盖，此条主要改 app CLAUDE.md K2 节澄清「archive 无条件」一段
8. **B8**：SKILL.md L27 「Opus 4.7 xhigh」 → 「Opus 4.7 default thinking」(M3)
9. **B9**：reviewer-{claude,codex}.md §核心纪律 第 9/12 条加 wire format invariant 锚定 (M5)
10. **B10**：reviewer-{claude,codex}.md §核心纪律「找不到 [msg ...]」段加「退化裸 message reply（不传 reply_to_message_id）+ 警告 lead 该 reply 不进 wait_reply 流程」(M6)
11. **B11**：`/Users/apple/.claude/templates/reviewer-{claude,codex}.sh.tmpl` 同步成 `$TMPDIR/...` mktemp 形式 (M8) — 这与 B5 user home 改动配套
12. **B12**：app CLAUDE.md L38「shutdown 不删数据」补 `messages` + 「team_member soft-exit / spawn_link 全保留」备注（A6 已在 src 侧改了 shutdown.ts + tools/index.ts，本条文档对齐）
13. **B13**：LOW + INFO 顺手批量改（SKILL.md「10 个 tool」 → 「5-6 核心 + 4-5 救火」 / SKILL.md Step 5 加 skip 字段格式示例 / SKILL.md「6 步」 → 「7 步」 / app CLAUDE.md L20 §Agent Teams stale ref 改写 / resources README 7 tool → 10 tool / app CLAUDE.md L37 send_message replyToMessageId 加「首条 null」/ reviewer-codex.md mktemp 注释加 sandbox 解释）

**所有指向代码资产的路径必须用 worktree 内绝对路径**：
- 代码: `<worktree>/src/main/agent-deck-mcp/...`
- 文档（含 plugin agents/skills）: `<worktree>/resources/claude-config/...`
- 协议 doc: `<worktree>/docs/agent-deck-mcp-protocol.md`
- changelog: `<worktree>/changelog/...`

**例外**（不在 worktree 的合法路径，直接用 home 路径）：
- user CLAUDE.md: `/Users/apple/.claude/CLAUDE.md`（B3 / B5 改）
- 外部 reviewer 模板: `/Users/apple/.claude/templates/reviewer-{claude,codex}.sh.tmpl`（B11 改）

**reviewer 续接（Phase C R2 时）**：
- 直接 `mcp__agent-deck__send_message({session_id, text, team_id: '6c080133-0aec-4dff-a271-f289f24dbee1'})` 给两个 reviewer 发 R2 prompt
- session id 见 plan 顶部「review reviewer 处理」节
- check_reply 锚点用 send_message 返回的新 messageId
- ⚠️ R2 prompt 必带 `skip` 字段（按格式 `已修：<filepath:line> <一句话改动> (commit 438a613)`），列上轮 ✅ fix 摘要

## 已知踩坑

- `process.cwd()` 在 mcp tool impl 里**不**等于 caller session cwd（这正是 H5 修的对象，A1 完成前任何 caller cwd 反查都不可靠）
- Edit/Read/Write/Grep/Glob 的 path 参数**全要带 worktree 前缀**，否则改到主仓库去（参考 ~/.claude/CLAUDE.md §Step 1 末 callout 防再踩 4 条）
- ~/.claude/CLAUDE.md 是 user-global，改它影响所有项目；改前确认必要性 + 措辞精准（B3 hand off 触发节属于必要性高的改动）
- wait_reply nudge 死锁修要保持 wire format 不动（reviewer 协议 invariant），只动 wait.ts 双查路径
