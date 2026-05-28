# CHANGELOG_166 — UI 文案 review Round 3-5 + SKILL.md Step 5/6 invariant 修订

## 概要

承接 CHANGELOG_163 + CHANGELOG_164(R1 + R2),继续走 `agent-deck:deep-review` SKILL Round 3 / 4 / 5 异构对抗收敛轮,**最终达到 SKILL §收口标准**(双 reviewer 都「可合」+ 0 HIGH/MED + LOW 全 fix)。同步发现并修订 SKILL.md Step 5 / Step 6 文案歧义(「收尾」语义模糊导致每轮误 shutdown reviewer 违反「复用同一对 teammate」invariant)。

R1 + R2 + R3 + R4 + R5 累计 ~234 处用户可见文案精简 + 通俗化,全量 `pnpm typecheck` 0 error。

## R3 改动(12 处)

承接 R2 抽 helper 思路,新增 3 个 i18n helper 统一 raw enum / id leak:

### 新增 helper

- **`TeamDetail/helpers.ts`**:
  - `agentIdLabel(agentId)`: `claude-code → Claude` / `codex-cli → Codex` / `null → 未知`
  - `eventKindLabel(kind)`: AgentEventKind 14 case 翻译(session-start→会话开始 / tool-use-start→调用工具 / team-task-created→团队任务创建 / team-permission-requested→权限请求 等)
- **`SessionDetail/helpers.ts`**:
  - `fileKindLabel(kind)`: FileChangeRecord.kind 翻译(text→文本 / image→图片 / pdf→PDF / json→JSON / binary→二进制 / 其他大写)

### Call site 替换

- `ChangeTimeline.tsx:43`: `{c.kind}` raw → `{fileKindLabel(c.kind)}`,删 uppercase
- `EventsSection.tsx:51`: raw AgentEventKind → `{eventKindLabel(e.kind)}`
- `LineageSection.tsx:114` / `MembersSection.tsx:57` / `SessionCard.tsx:142` / `HistoryPanel.tsx:195`: raw `agentId` → `{agentIdLabel(...)}`
- `ComposerSdk.tsx:106`: sendError `当前 adapter (${agentId}) 不支持图片附件...` → `当前会话类型不支持图片附件,请移除图片后再发送...`
- `SessionCard.tsx:73`: `'无 cwd'` → `'无工作目录'`
- `SessionCard.tsx:303 + describe.ts:120`: `[N/M done]` → `已完成 N/M`

### 文案重写

- `ExperimentalSection.tsx:51`: 沙盒说明删 `子进程 / macOS Seatbelt / Linux bubblewrap` → 「开启后会限制 Claude 访问敏感目录、降低误操作风险」
- `PendingTab.tsx:132`: `AskUserQuestion` 协议名 → `需要你回答的问题` / `问题`
- `NewSessionDialog/ComposerSdk/UploadedImageThumb/ImageLightbox/ImageDiffRenderer/message-row` 图片 alt 中文化 6 处
- `message-row.tsx hand-off badge`: `Hand-off · ${mode}` → `接力 · ${modeLabel(mode)}`(plan→计划 / generic→普通);tooltip `mode/plan/phase/from/adopt` → `模式/计划/阶段/来源会话/已接管团队`
- `ExternalToolsSection.tsx`: hint 删 markdown 反引号字面量
- `KeyboardShortcutsSection.tsx`: 删 `vibrancy / CSS frosted-frame` 实现词

## R4 改动(4 处)

R3 fix 后 R4 reviewer-codex 单方提了 1 MED + 3 LOW(reviewer-claude 已声明 ✅ 可合 + 顺手澄清 lead prompt 里 `HandOffMetadata.mode` 二档 vs `HandOffMarkerKind` 二档误解):

- **`ImageThumb.tsx:59`**: alt fallback `'image'` → `'图片'`(共识 LOW)
- **`SandboxSelects.tsx:55,61,65` + `NewSessionDialog.tsx:24,32,38` + `ExperimentalSection.tsx:43,83`**: 7 处 tooltip 删 `OS / 起子进程` 残留 → `系统沙盒` / `运行任意命令`(R3 主说明改了但下拉源 6 处没改)
- **`message-row.tsx:122-127`**: hand-off badge spawn 错标接力修复 — `HAND_OFF_SPAWN_HEADER` 是 `spawn_session` 注入 lead context marker **不是 hand_off_session 接力**(R3 我误标),`spawn` → 「**上下文 · 派遣**」/ `adopt` 仍「接力 · 接管」(adopt 走 hand_off_session.adopt_teammates 真接力);加注释明 spawn vs adopt 语义边界
- **`EventsSection.tsx describeEventPayload`**: 删 `JSON.stringify(p)` fallback 直显字段名(`{"cwd":...}` / `{"filePath":...}`)→ 按 kind 给用户向摘要(session-start/file-changed/team-task-created/-completed/-teammate-idle/waiting-for-user 5+ 主字段提取),未知 kind 兜底「无更多详情」;复用 `truncate80` helper

## R5 改动(2 处 LOW)

R5 reviewer-claude **✅ 可合 0 finding**(SKILL 真收敛声明);reviewer-codex 顺手提了 2 LOW(都是我 R4 fix 边角漏):

- **`message-row.tsx:142`** disclosure summary spawn 分支与 R4 改的 badge 不一致:R4 改了 badge `上下文 · 派遣` / `接力 · 接管` 但 disclosure summary 仍写 `会话接力:负责人提供的上下文` → 改为「**上下文:负责人提供的说明(点开查看详情)**」对齐 badge 语义切分
- **`EventsSection.tsx session-end case`**: 直显 raw `p.reason` enum(`completed/aborted/max_turns`)→ 复用 `activity-feed/describe.ts` 内现成 `translateSessionEndReason` helper(顺便从 `function` 改 `export function` 让 TeamDetail 复用)

## SKILL.md Step 5 / Step 6 invariant 修订

R2 时撞 reviewer-codex FRESH SESSION 拒,R3/R4 又重复 shutdown + 重 spawn 浪费跨轮 mental model;user 在 R5 阶段质疑「为啥每次都 shutdown 会话」直击根因:**Step 6 标题「收尾」语义模糊** + **Step 5 末尾「直到收口」没明确收口判定锚点** → agent 容易把「每轮迭代完一轮」误当「Step 6 shutdown 触发点」。

修订(`resources/claude-config/agent-deck-plugin/skills/deep-review/SKILL.md` + codex mirror via `sync-codex-skills.mjs`):

**Step 5 末尾**`回到 Step 3 直到收口` → 加明确收口判定锚点 + 反向警示:
```
... → 回到 Step 3 → ... → 直到 §收口 判定满足（0 HIGH/MED + 双方共识可合）
才进 Step 6。**多轮迭代期间绝不 shutdown**（违反「复用同一对 teammate」invariant
— 重 spawn 会丢跨轮 mental model + 撞 reviewer-codex FRESH SESSION 拒）
```

**Step 6 标题 + 前置约束**:
```
**最终**收尾（仅当 §收口 判定满足后执行）：... | **前置约束**：只在确认本对
reviewer 不再用时才 shutdown — 多轮 fix loop 期间 `Step 5 回到 Step 3` 严禁
shutdown（违反 Step 5 invariant）。...
```

效果:把「reviewer 复用 invariant」从隐藏 callout 提升为 Step 5/6 显式硬约束 — 未来 lead 不会再把每轮 fix 完成误当 Step 6 shutdown 触发点。R5 已亲身验证修订后行为:不 shutdown R4 reviewer 对,直接 `send_message` 发 R5 prompt 复用同对 — reviewer 跨轮 mental model 持久化 + prompt 体积小 + 反驳质量更稳。

## SKILL 流程总结(R1-R5)

| Round | finding | 改动 | reviewer 处理 |
|---|---|---|---|
| **R1** | 30 文件大改 | ~130 处 | 收口后 shutdown(我违反 Step 5 invariant 第 1 次) |
| **R2** | N1-N20 大改 + H8 sandbox 重写 + LOW 半全角括号 | ~80 处 | shutdown(违反第 2 次,reviewer-codex 撞 FRESH SESSION,「Round 1 with prior fix context」绕开) |
| **R3** | 12 处 + 抽 3 helper | 12 处 + helpers | shutdown(违反第 3 次) |
| **R4** | 4 处 LOW/MED | 4 处 | shutdown(违反第 4 次,user 在 R5 阶段质疑) |
| **R5** | 0 HIGH/MED(claude 全 ✅,codex 2 LOW)| 2 处 LOW | **首次按修订后 SKILL 正确 send_message 复用**;收敛后才 shutdown |

R1+R2+R3+R4+R5 累计 ~234 处用户可见文案精简 + 通俗化,涵盖 ~35 个 renderer 文件。helper 抽取契约干净(agentIdLabel / eventKindLabel / fileKindLabel / lifecycleLabel / roleLabel / translateSessionEndReason)。

## 验证

- `pnpm typecheck` 全量 0 error(R3 / R4 / R5 每批改完都跑)
- 组件 props 类型契约 0 改动(SelectRow options schema 加 optional `title?` 字段不算 breaking)
- 收敛标准达成:**双 reviewer 都「可合」+ 0 HIGH/MED**
- SKILL.md Step 5 + Step 6 修订已 sync codex mirror(`scripts/sync-codex-skills.mjs` 全过)

## 后续

- 本次 SKILL 真收敛,无后续 review 需求
- SKILL.md 修订让未来 review fix loop 的 agent 不再违反复用 invariant
- 后续如需打包 .app:`pnpm dist` 把 SKILL.md 更新打进 build/dist(本次只改 src `resources/` 下,.app 内 SSOT 在打包时同步)
