# REVIEW_77 — 全项目 deep review 批 C3：claude-code sdk-bridge stream/translate/finalize

- 日期: 2026-05-31
- 类型: Debug / 功能 BUG + 代码优化 + 文字措辞（全项目 deep review 第七批，Batch C 子批 C3）
- 触发: 用户「deep review 下项目，自主一路推进 + 自主 hand off」授权（plan deep-review-project-20260531）
- 关联: plan deep-review-project-20260531 / REVIEW_71-76（A1/A2/B1/B2/C1/C2）
- 方法: 多轮异构对抗（reviewer-claude Opus 4.7 + reviewer-codex gpt-5.5）+ 三态裁决 + lead 全链 trace（ingest 3a findByCliSessionId → dedupOrClaim → isRecentlyDeleted）+ changelog 溯源 + 跑测取证。**fresh pair**（hand-off 后新 caller session 4a53af3a；旧 C1-C2 pair 已 closed 不可复用 → 按 plan §step 5 重 spawn 新 team dr-project-c3-20260531）。
- 收口: R1 双 reviewer reply **双方独立收敛 clean**（reviewer-codex 0 HIGH/0 MED/0 LOW + 2 INFO；reviewer-claude 0 HIGH/0 MED + 1 LOW（自评倾向非 bug）+ 2 INFO）→ 无单方 HIGH 不需反驳轮 → 三态裁决：3 INFO fix（措辞/注释精确化）+ 1 LOW 现场验证为「刻意设计正确」不改代码仅补注释。typecheck 双配置 + sdk-bridge 73 passed（comment-only 改动无新回归 test）。

## 范围（批 C3）

claude-code SDK adapter bridge 的「SDK 流消费 + 消息翻译 + session finalize + jsonl-missing fallback + sendMessage 校验」子模块，5 文件 ~1386 LOC：

| 文件 | LOC | 职责 |
|---|---|---|
| `sdk-bridge/stream-processor.ts` | 474 | StreamProcessor（makeUserMessage / createUserMessageStream / waitForRealSessionId 30s fallback / consume 流消费 + race guard + finally 三面 cleanup） |
| `sdk-bridge/sdk-message-translate.ts` | 337 | translateSdkMessage（assistant/user/result/system 4 分支）+ pushFileChangeIntent / consumePendingFileChangeIntent / maybeEmitImageFileChanged 纯函数 |
| `sdk-bridge/session-finalize.ts` | 201 | finalizeSessionStart（emit session-start → updateCliSessionId 黑名单链 → setClaudeCodeSandbox/setModel/setExtraAllowWrite → emit 首条 user message） |
| `sdk-bridge/jsonl-fallback.ts` | 309 | maybeJsonlFallback（jsonl 预检 OR 短路 + fresh-cli-reuse-app fallback + emit 顺序契约 + skipFirstUserEmit 双气泡防护） |
| `sdk-bridge/send-validation.ts` | 65 | validateSendMessageOrThrow（长度上限 / 队列上限 / pending warning emit 三段直线校验） |

## 三态裁决结果

### [INFO ✅ 双方独立] sdk-message-translate.ts:122 — CHANGELOG_`<X>` 占位符未替换

reviewer-claude + reviewer-codex **双方独立**提出（异构强冗余即算验证）。注释残留 `CHANGELOG_<X>` 占位符，本轮 focus 明列的 changelog/comment placeholder。

```ts
// CHANGELOG_<X> A1：tool-use-end status 跨 adapter 统一字段。
```

**lead 溯源验证**：`git blame` → da7f2243（2026-05-11）引入。grep `ref/changelogs/` 命中 **CHANGELOG_61** §A1 字面对应（"claude tool_result block 的 `is_error` 翻为 `status: 'failed' | 'completed'`，与 codex tool-use-end 字段对齐"）。

**修法**：`CHANGELOG_<X>` → `CHANGELOG_61`。

### [INFO ✅ codex] stream-processor.ts:287-308 — race guard 注释描述已废的 realSessionId / 三档 sid 链

reviewer-codex 提出。代码已切到 `cliSessionId` guard（line 302）+ `applicationSid` 统一派发（line 385），但注释仍写 `internal.realSessionId` 和 `sid = realId ?? internal.realSessionId ?? tempKey` 三档链。运行时代码正确，纯维护风险（误导下一轮 race 修复）。

**lead 验证**：
- `grep realSessionId types.ts` → line 104「rename `realSessionId` → `cliSessionId`」，字段已不存在
- 实际 guard（line 302）：`internal.cliSessionId !== null && internal.cliSessionId !== incomingId`
- 实际事件派发（line 385）：`const sid = internal.applicationSid`（单一来源，非三档链）

**修法**：重写 line 287-308 注释为当前双轨语义（fallback 后 cliSessionId 锁 fallbackId；事件派发恒用 applicationSid；late first-id 仅跳过 mutation）。保留 line 205「旧 impl 仅改 internal.realSessionId」+ line 400/416-417「替代旧三档链」/「不再三档链」—— 这些是描述 OLD→NEW 迁移的合法历史锚点，不改。

### [INFO ✅ claude] stream-processor.ts:461-463 — C1 注释对 dedup 丢弃机制描述不精确

reviewer-claude 提出。C1 注释称「后续同 CLI sid 的迟到 hook event 在 dedupOrClaim 第 2 分支 `hasSdkClaim(sid)` 命中被静默丢弃」。

**lead 全链 trace 验证**（确认 reviewer-claude 正确）：ingest 入口 `manager.ts:309` 的 3a `findByCliSessionId` 跑在 `dedupOrClaim`(line 324) **之前**，命中时先覆写 `event.sessionId`→applicationSid，故 dedupOrClaim 检查的是 `hasSdkClaim(applicationSid)`（finally line 456 已释放）**不是** `hasSdkClaim(cliSid)`。注释描述的「cliSid claim 命中丢弃」仅在 3a 不命中时成立，注释没写该前提。

**修法**：精确化注释 —— C1 修法**主因是 #sdkOwned Set 条目泄漏**（fork/fresh 每会话留一条 cliSid claim 永不释放，累积到应用重启），「迟到 hook 丢弃」仅 3a 不命中时才靠 cliSid claim 顺带挡，非主因。release 修对了，仅注释把「cliSid leak」与「dedup 丢弃」错误关联。

### [LOW ❌ 不改代码 / claude（自评倾向非 bug）] stream-processor.ts:467-470 — C1 cliSid release 只 mirror「释放」未 mirror「黑名单」

reviewer-claude 提出（自评倾向非 bug，提示 trade-off 给 lead 裁决）。对照 `pending-cancellation.ts:107-127`（closeSession 路径）三面 release **之后**还做三面 `markRecentlyDeleted` 60s 黑名单；C1 的 finally（line 467-470）只 mirror release 没 mirror 黑名单。

**lead 现场验证（裁定：代码正确，刻意设计，不改代码）**：
- reviewer-claude 推理结论正确（**不应**加黑名单），但**支撑理由有一处事实错误需更正**：它称「黑名单只挡 source='hook'，对 source='sdk' 的合法 resume 无害」。实测 `manager.ts:317-320` 的 `isRecentlyDeleted` 检查在 ingest 入口**早返、不区分 source**（3b 分支在 3a 覆写后、dedupOrClaim 之前无条件 `if (this.isRecentlyDeleted(event.sessionId)) return`）。
- 故真实情形相反：若在自然 stream-end 路径加 cliSid 黑名单，会**误挡** 60s 内合法 resume（dormant→resume 走 source='sdk' 也会被 3b 早返 drop）。
- **语义裁定**：自然 sdk-stream-ended → `advanceState` 设 **dormant**（设计上允许用户随时 resume 复活）；closeSession → **closed**（禁止复活，故才加黑名单）。两者语义相反 → dormant 路径**不该**加黑名单。与同 finally 内 applicationSid release（line 456，C1 之前旧代码，黑名单同样不加）一致。

**修法**：代码不动（C1 正确）。补注释明确「刻意只 mirror release 不 mirror 黑名单」的语义理由（dormant 允许复活 vs closed 禁止复活），防下一轮 review 误判为漏修。

## 其余 focus 全部 ✓ 无 finding（双方共识可合）

reviewer-claude + reviewer-codex 双方独立确认以下路径无真 bug（跨 8 个支撑文件验证 race/claim/ingest 链）：

① **race guard**（line 302 `cliSessionId !== null && !== incomingId`）— ctor `cliSessionId: null`（types.ts:227）保证 spawn first-id 不误命中，fallback 后 set fallbackId 挡 late id，`setttimeout-fallback-symmetry.test.ts` case II 已 land 验证 ✓
② **consume finally** 清 3 pending Map（permission/askUserQuestion/exitPlanMode）+ pendingFileChangeIntents（line 445）+ 三面 delete/release ✓
③ **C1 新加 line 467-470 cliSid 释放**：spawn 成功 cliSid===sid 不进 C1 新分支（无误释放）；fork/fresh cliSid≠sid 才释放（修对 leak）✓
④ **thinking-prelude 启发式**（line 75-90）4 case 自洽 ✓
⑤ **pushFileChangeIntent / consumePendingFileChangeIntent**：toolName/toolUseId null 边角 + failed 仅 delete 不 emit ✓
⑥ **result frame** expectedClose 整段 return（line 170，三通道红字/finished/通知一起 skip）✓
⑦ **permissionMode 同步**：先同步 internal cache 再 DB 比对（sessionId=applicationSid 维度正确，line 199-214）✓
⑧ **jsonl-fallback**：OR 短路（line 219 cwdFellBack=true 不调 jsonlExistsThunk fail-safe 不被绕过）+ emit 顺序（createSession→info→user）+ createSession 抛错 rethrow 不 emit + skipFirstUserEmit 双气泡防护 ✓
⑨ **send-validation** 三段直线逻辑（长度/队列/pending warning）无 bug ✓
⑩ **finalizeSessionStart** updateCliSessionId 统一走 manager wrapper 黑名单链（C1 已修，line 140-149 复查正确）✓

## 验证

- `pnpm typecheck`（tsconfig.node.json + tsconfig.web.json 双配置）✓ exit 0
- `vitest run src/main/adapters/claude-code/sdk-bridge/__tests__/` → **10 files / 73 passed** ✓
- reviewer-codex 独立跑 6 focused vitest（setttimeout-fallback-symmetry / createsession-failure-cleanup / jsonl-fallback / file-change-intent-delay / sdk-status-permission-mode-sync / restart-controller-jsonl-precheck）44 断言全过（exit=1 是 sandbox EPERM 写 vitest cache，非测试失败）
- 本批 3 处改动全 comment-only（无运行时行为变更），不需新增回归 test（既有覆盖已充分；reviewer 双方确认）

## 结论

C3 子批 **0 真 bug**（高质量拆分 + C1/C2 已修点经 fresh pair 复查全部正确）。4 条 finding：3 INFO 措辞/注释精确化（含 CHANGELOG_61 占位符回填）已 fix；1 LOW 现场验证为「刻意设计正确」不改代码仅补语义注释（且更正了 reviewer 支撑理由的一处事实错误：黑名单不区分 source）。
