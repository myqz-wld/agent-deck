# REVIEW_107 — renderer settings/TeamDetail UI 簇 deep-review（Batch 9：dead UI scope 误差被异构对抗抓出 + 收口）

## 范围

全项目滚动 deep-review **Batch 9**（plan `deep-review-project-rolling-20260602`）。renderer UI 簇，初选 8 文件，**审中发现 1 个为意图性 dead UI（用户 5/28 主动下架）→ 用户决策删除，最终有效 scope 4 文件 + 1 抽离模块**。

初选 scope（精核 fp:NONE + spot-check 真 logic）：
- `settings/sections/CodexMcpServersSection.tsx`(176) — **审中发现意图性 dead UI（零挂载），用户决策删除**
- `settings/CodexAgentsMdEditor.tsx`(155) — 排除（fp:NONE 但 R1 双方 PASS：dirty 追踪 + 异步 race + cleanup 契约均无问题，无 finding）
- `TeamDetail/EventsSection.tsx`(122) + `TasksSection.tsx`(100) + `MessagesSection.tsx`(88) + `PendingSection.tsx`(85) + `Header.tsx`(65) + `helpers.ts`(117) — 真 logic-heavy，mounted 在用

最终改动文件：
- `TeamDetail/PendingSection.tsx` — MED-D fix（复用 selectPendingBuckets）
- `TeamDetail/EventsSection.tsx` — LOW-A 守门 + INFO desc hoist + 抽离 describeEventPayload
- `TeamDetail/helpers.ts` — LOW-B relativeTime NaN 守门
- `TeamDetail/events-payload-describe.ts`（新增）— describeEventPayload/truncate80 抽离（node-env 可测）
- **删** `settings/sections/CodexMcpServersSection.tsx`（意图性 dead UI）
- 新增测试：`TeamDetail/__tests__/events-payload-describe.test.ts`(17) + `lib/__tests__/session-selectors.test.ts`(7)

## 结论

**R1+R2+R3 三轮异构对抗收口**。reviewer-claude(Opus4.7) `4fb4ce50` + reviewer-codex(gpt-5.5) `019e8784`，teamId `aff7ab01`（已 shutdown）。lead 现场验证（node sim relativeTime NaN/parseAndValidate 边角 + 读码 trace MarkdownText XSS 面/selectPendingBuckets 过滤口径 + git 考古 dead UI 下架链 + 端到端持久层完整性核验）。

**R3 双 reviewer both-agree conclude，0 HIGH 0 真 MED**。typecheck 双配置双绿 + 123 renderer tests 零回归（删除后；含 +24 新测试）。

## 异构对抗高光 — 集成可达性维度抓出 scope 误差（本批最大价值）

**reviewer-codex R2 抓出 HIGH-1**：`CodexMcpServersSection` 完全零挂载（rg 全 renderer 只命中自身定义），lead R1 的所有 fix 都在用户路径不可达的死组件上。

这命中了 **reviewer-claude + lead 共同盲区**：claude R1/R2 在隔离审「组件本身对不对」（判 byte-equivalent + conclude），lead 预备分析也只审组件逻辑，**双方都没查「组件在用户路径是否可达」**（零 importer / 是否挂载进 settings 注册表）。reviewer-claude R3 主动 acknowledge 并升级 mental model：「审组件先 grep importer，零 importer 直接质疑 dead code，否则审得再细也是给死代码做无用功」。

**lead git 考古坐实**（决定性裁决）：
- commit `09f58a3`（5/11）：建 CodexMcpServersSection + 挂到 SettingsDialog
- commit `0137aad`（5/28，CHANGELOG_160）：**用户主动要求**「不管 mcp 也去掉 codex mcp」→ 删 UI 挂载，**字段持久化保留 / UI 不暴露 / 文件故意留**

→ 非 regression bug，是用户决策的意图性 dead UI。**用户 R2 后决策：删整个 dead 组件**（settings.codexMcpServers 字段持久化 + toml 同步层保留，只删 UI 编辑层死代码）。

## Finding 与裁决

### R1 finding（CodexMcpServersSection 相关随删作废，TeamDetail 相关有效）

#### [MED ✅ 随组件删] CodexMcpServersSection save 后 draft 不回灌 → dirty 永久卡 true
- **来源**：reviewer-claude 单方 + lead node 实测（紧凑输入保存后 `dirty=true` 铁证）。`save()` 缺 `setDraft(formatJson(parsed))`，同源兄弟 CodexAgentsMdEditor:59 有回灌。
- **R1 处置**：加 `setDraft(formatJson(parsed))` 回灌。**R2 后随 CodexMcpServersSection 整组件删除作废**——非判断错（claude 审「组件对不对」是对的），是组件本身不该在 scope（dead UI）。

#### [MED ✅ 随组件删] CodexMcpServers parseAndValidate 校验漏 XOR/重名/reserved/非空
- **来源**：reviewer-codex 单方 + lead node sim（`command:""` 通过 + 重名不拦 + 无 reserved `agent-deck` 检查）。下游 toml-writer 写出歧义/重复 table。
- **R1 处置**：抽 `codex-mcp-servers-logic.ts` + 补 trim/Set 去重/reserved 拒/XOR 严格/空串拒 + 21 测试。**R2 后随组件删除作废**。
- **codex R2 增量（follow-up 价值）**：parseAndValidate 仍允许 HTTP 带 args/env、stdio 带 bearerTokenEnvVar，codex **0.135.0 实测** `args is not supported for streamable_http` / `env is not supported for streamable_http` / `bearer_token_env_var is not supported for stdio`（transport-specific 字段互斥铁证）。组件已删此校验不存在，但 **若未来重新挂载 UI 编辑通路，需补 transport-specific 字段交叉校验**（见 follow-up）。

#### [MED ✅] PendingSection 漏 archived/lifecycle 过滤，导向不可处理会话 — **仲裁矛盾**
- **来源**：reviewer-codex 判 MED 真问题 / **reviewer-claude 判 INFO ✅ PASS（误判同源）**。**lead 仲裁裁定 codex 对**：
  - PendingTab 确用 `selectPendingBuckets`（PendingTab.tsx:4/41），带 `archivedAt !== null` + `lifecycle ∉ {active,dormant}` 过滤（session-selectors.ts:47-48）——claude 误以为两者「同源 raw maps + leftAt 过滤一致」，实际 PendingTab 走 selector 不是裸 maps。
  - `archive.ts:59` 只 `UPDATE sessions SET archived_at`，**不碰 team_member.left_at**（archive 与 membership 正交，CLAUDE.md 明确）；pending Map 仅 `removeSession` 清，close/archive 残留 → **archived-but-active-member 可达** → PendingSection 显示 PendingTab 已隐藏的不可处理会话。
- **lead 现场验证**：trace shutdown_session → sessionManager.close → leaveTeamsAndAutoArchive 写 leftAt（closed 子case 不可达，PendingSection leftAt 已滤）；但 archive 路径不碰 leftAt（archived 子case 可达）。
- **修复**：PendingSection 改为复用 `selectPendingBuckets`（继承 archivedAt + lifecycle 过滤 + waiting/lastEventAt 排序）后按 member sidSet 过滤，消口径漂移。useMemo deps `[members, sessions, pendingPerms, pendingAsks, pendingExits]`（双 reviewer R2 确认完整无多余）。+ 7 selectPendingBuckets 测试（该 selector 此前 0 测试）。

#### [LOW ✅] EventsSection truthy 非 string 原始值 payload `'in'` 抛 TypeError → 整 app 崩
- **来源**：双方独立命中（codex MED / claude LOW）。**lead 双通道核实定 LOW**：`payload: unknown`，DB `JSON.parse(...) as unknown` 不收窄 → 类型上 primitive 可达，`'text' in 42` 抛 TypeError（node repro）；TeamDetail 无 local ErrorBoundary，唯一 RootErrorBoundary 在 app 根 → blast radius = 整 app 持久错误页（同 REVIEW_98 Monaco 类）。**但 SDK + hook 两通道 emitter 全产 object payload（lead grep emit 站点 + hook-routes translate* 均构造 object）→ 当前不可达**，自降 LOW。
- **修复**：`typeof e.payload !== 'object'` 守门兜底（blast radius 大，护栏成本一行值得加，同 REVIEW_98 不可达但代价小则修）。

#### [LOW ✅] helpers.relativeTime(NaN) → "NaN 天前"
- **来源**：双方共识 LOW。`Math.max(0, NaN)=NaN` → 所有区间比较 false → 末尾 "NaN 天前"（node 实证）。TasksSection 走 `relativeTime(Date.parse(updatedAt))`，Date.parse 是唯一 NaN 注入口（events/messages ts 是 number 直传安全）；TaskRecord.updatedAt 恒合法 ISO 不可达，shared helper 防御护栏。
- **修复**：`if (!Number.isFinite(ts)) return ''`（三个 caller 全受益）。

#### [INFO ✅] EventsSection describeEventPayload 每行算 2 次
- **来源**：claude 单方。`title=` 与内容各调一次（50 条 ×2=100 次/render）。
- **修复**：hoist `const desc = describeEventPayload(e)` 复用。

### R2 finding（CodexMcpServersSection 相关，删组件根治）

| Finding | 来源 | 处置 |
|---|---|---|
| HIGH-1 CodexMcpServersSection 零挂载 dead UI | codex 单方（集成可达性维度）| ✅ git 考古证意图性 dead UI（用户 5/28 下架）→ **用户决策删整组件** |
| MED-2 parser 允许 transport-specific 字段错配（Codex 0.135 实测拒）| codex 单方 | 删组件后 parser 不存在；**记 follow-up（未来重挂 UI 需补）** |
| MED-3 SettingsDialog.update 吞错误报保存成功 | codex 单方 | 删组件后不进用户路径；codex 自认「被 HIGH-1 遮蔽」 |

**lead 现场验证 MED-3**：`SettingsDialog.update`（:101）catch 设 actionError 不 rethrow 属实 → 若 section 挂载，child `await update()` resolve 会误显「✓ 已保存」。但 HIGH-1 删组件后不可达。

### R3 收口确认

- **reviewer-codex**：0 HIGH/MED，独立复验删除干净（rg 零命中）+ 持久化层完整（字段/toml-writer/ipc apply 全在）+ R2 其他修法 OK + 24 test + typecheck 双绿 → 同意 conclude。
- **reviewer-claude**：0 HIGH/MED，acknowledge 集成可达性盲区 + 升级 mental model + 实测 5 项确认（删除干净/零 dangling/dead UI 零挂载坐实/持久化保留/剩余 4 文件 R2 结论不变）→ 同意收口。
- **lead 最终自验**：全仓零残留引用 + 持久化端到端链完整（app-settings:329 字段 → ipc/settings:271 注册+149 impl → toml-writer:123 export）。

## 正向确认（reviewer 验证为安全/正确，无需改）

- **MessagesSection msg.body XSS 安全**：MarkdownText 不挂 rehype-raw（默认 escape raw HTML）+ react-markdown v10 safeProtocol 剥离 javascript:/data: URI + 链接强制 noopener。cross-adapter 来源无注入面（claude 实测 + lead 读码确认）。
- **EventsSection raw-leak 安全**：default 分支返「无更多详情」非 JSON.stringify（R4 已修），不暴露 raw 字段名。
- **MessagesSection slice(0,30) 不丢新数据**：listByTeam `ORDER BY sent_at DESC, rowid DESC` newest-first，slice 取最新 30。
- **CodexAgentsMdEditor cleanup 契约**：useEffect 卸载上报 false + 父级 onSubDirty/onClaudeMdDirtyChange 全链 useCallback memoize 无 flicker。
- **key 稳定性**：EventsSection/TasksSection/MessagesSection/PendingSection 全用稳定主键无 index key。
- **XOR 校验不误拒**（删前确认）：toml-writer.ts:50 类型 doc 明示 stdio/http「mutual exclusive」，XOR 符合既有契约。

## 遗留 follow-up（非阻塞，双方裁定可接受）

1. **transport-specific 字段交叉校验**（codex R2 MED-2，Codex 0.135 实测铁证）：CodexMcpServersSection 已删，但 `settings.codexMcpServers` 字段仍持久化 + toml-writer 仍写盘。**当前无 UI 编辑入口**（用户手编 settings.json 自负责），但 toml-writer 若收到 HTTP+args / stdio+bearer 会写出 Codex 拒绝的配置。**若未来重新挂载 UI 编辑通路**，需在 parser / toml-writer 补 transport-specific 字段拒绝（hasHttp 拒 args/env，hasStdio 拒 bearerTokenEnvVar）。需独立小 plan。
2. **renderer 组件级测试环境**（jsdom + @testing-library）：当前 vitest node-env 只能测抽离的纯逻辑（events-payload-describe / session-selectors），组件渲染行为（PendingSection 实际过滤渲染 / EventsSection 列表）无 committed 组件测试。与既有 renderer 测试模式一致（image-attachments-logic / SessionDetail helpers 都测纯逻辑），非本批新欠债。

## Batch 9 新增方法学教训（已写入 plan §方法学铁律）

⑩ **fp:NONE 只证「未被 review」，不证「在用户路径可达」**——renderer 组件选批除 fp:NONE + 函数密度 + spot-check 真 logic，还**必须 grep importer / 挂载点**确认非 dead code（零 importer → git 考古查是否意图性下架，dead UI 不进 deep-review，类比 Batch 8 教训⑦ thin-wrapper + Batch 5 D-1 flash() intentional-dead）。本批 CodexMcpServersSection 是 fp:NONE 真未审但**用户 5/28 主动下架的零挂载 dead UI**，加固它是给死代码做无用功。集成可达性是 reviewer-codex 命中、reviewer-claude + lead 共同盲区的维度——**异构对抗的核心价值正在于一方的盲区是另一方的强项**。
