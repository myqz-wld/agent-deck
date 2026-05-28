# REVIEW_60 — Deep-Review 批 B: sdk-bridge 双端 (claude-code + codex-cli)

> 触发：用户请求 deep code review 批 B（继 REVIEW_59 批 A 之后），聚焦于跨 adapter sdk-bridge 状态机一致性 / 断连自愈正确性 / cwd resilience / 资源 lifecycle。批 C（剩余 8 文件）/ 提示词资产 / plantUML 图独立批次。
>
> 工具链：agent-deck:deep-review SKILL（多轮异构对抗 reviewer-claude + reviewer-codex 跨 adapter spawn）+ 三态裁决 + 多轮 fix loop。
>
> 关联 fix：[CHANGELOG_170.md](../changelogs/CHANGELOG_170.md)。

## Scope

| 文件 | LOC | 角色 |
|---|---|---|
| `src/main/adapters/claude-code/sdk-bridge/index.ts` | 793 | claude SDK bridge facade（createSession / sendMessage / handleStream / abort 主路径 + tempKey→realId rename + sdkOwned claim） |
| `src/main/adapters/codex-cli/sdk-bridge/index.ts` | 954 | codex SDK bridge facade（同款语义 + per-session token allocate + ensureCodex 子进程引用 + thread-loop earlyErrCb 4 资源 cleanup） |
| `src/main/adapters/claude-code/sdk-bridge/recoverer.ts` | 662 | claude 断连自愈（recoverAndSend single-flight + cwd 启发式 fallback + jsonl-fallback helper + LLM 摘要 prepend） |
| `src/main/adapters/codex-cli/sdk-bridge/recoverer.ts` | 609 | codex 断连自愈（同款 + jsonl missing fresh thread fallback + cwd date-based 路径独立于 cwd） |

合计 3018 LOC + 关联调用方（stream-processor.ts / thread-loop.ts / restart-controller.ts / jsonl-fallback.ts / mcp-session-token-map.ts / translate.ts）。

## 流程

### Round 1 — 全量 review（kind='code'）

并发 spawn 跨 adapter 异构对：
- reviewer-claude（claude-code adapter，Opus 4.7 default thinking） sid `eebbf8b2`
- reviewer-codex（codex-cli adapter，gpt-5.5 xhigh） sid `019e6dfd`

prompt 含 6 个 focus 维度：① 跨 adapter 状态机一致性 ② 断连自愈正确性 ③ cwd resilience ④ 资源 lifecycle / 资源泄漏 ⑤ 边界条件 / 并发 race ⑥ 测试覆盖度。

**reviewer-codex R1 输出**（3 条）：0 HIGH / 2 MED / 1 INFO。
**reviewer-claude R1 输出**（2 条）：0 HIGH / 0 MED / 1 LOW / 1 INFO（含 8 项 CONFIRMED OK 主动证伪 sessions Map leak 候选）。

合计 5 条独立 finding，2 条共识（codex INFO ≈ claude LOW codex jsonl-missing fallback 缺 LLM 摘要 prepend cross-adapter parity gap）。

### Round 2 — fix-to-fix + 边界并发 race + 资源 lifecycle 深挖

R1 fix 后发 R2 prompt 让 reviewer 检查 fix 是否引新问题 + 挖深层。**R2 期间 lead 通过用户截图发现额外 finding**（codex CLI loader warning 红 bubble UI 污染）。

**reviewer-codex R2 输出**（2 条）：0 HIGH / 1 MED test 缺口 / 1 LOW test 缺口（R1 两处 src 修法本身未发现新破坏）。

**reviewer-claude R2 输出**（1 条）：1 HIGH（**R1 fix 范围之外**的 plan reverse-rename-sid-stability-20260520 §A.4-pre regression — claude createSession catch 块 sessions.delete(tempKey) 与 sessions.set(applicationSid) parity gap，与 codex R1 修法形成跨 adapter 反证）。

**lead 现场新增 1 条 MED-Lead-1**：用户截图实测 codex SDK ErrorItem 无差别 emit error: true 红 bubble 污染 UI。

合计 R2 4 条独立 finding。

### Round 3 — 收口 confirm

R2 fix 后发 R3 prompt 让 reviewer 收口判定（不再扩 scope）。

**reviewer-claude R3 输出**：✅ 0 HIGH/MED/LOW + 1 INFO *未验证*（其他 codex CLI 启动期间高频 loader warning pattern 未确证，等用户报项再扩）。三分支验证（resume / spawn 主路径无 first realId / spawn 主路径 first realId 已切但 try 内 throw）+ 边角扫除全 PASS。

**reviewer-codex R3 输出**：✅ 0 HIGH/MED finding。grep 确认 `sessions.set(internal.applicationSid)` 在 L380 + catch 清理在 L448-L453 双 key 覆盖三条路径。loader warning filter 命中后只 console.warn 并 return，非匹配 ErrorItem 仍走原 emit。

**双方共识 ✅ 可合**。

## 三态裁决总表

| # | 文件:行 | 严重度 | 来源 | 裁决 | 验证依据 |
|---|---|---|---|---|---|
| F1 | claude/codex recoverer.ts L385/L315（旧位） | MED | R1 reviewer-codex 单方 | ✅ lead 验证 | inflight check 与 `recovering.set` 之间存在 `await sessionManager.unarchive` 窗口，archived session 并发 sendMessage 双 IIFE → 双 createSession 破坏 single-flight 不变量 |
| F2 | codex sdk-bridge/index.ts L429-L760 | MED | R1 reviewer-codex 单方 | ✅ lead 验证 | createSession 整个函数体无顶层 try/catch，allocate 之后 ensureCodex / startThread / resumeThread sync throw 让 token + (可能已 set 的) codex 实例 + sessions Map entry + sdkClaim 全泄漏；与 claude createSession L31-L165 try/catch 收口模板形成 cross-adapter parity gap |
| F3 | claude sdk-bridge/index.ts L436（旧位） | HIGH | R2 reviewer-claude 单方 + lead 现场 | ✅ 三分支验证 + jsdoc 矛盾佐证 | catch `sessions.delete(tempKey)` 但 plan A.4-pre §S2 已切 sessions.set 用 applicationSid，resume 路径 applicationSid=opts.resume≠tempKey → no-op leak；与 codex/sdk-bridge/index.ts L799 initialSid 形成对照反证 |
| F4 | codex translate.ts L385-389（旧位） | MED | lead 现场（用户截图）+ codex SDK ErrorItem 类型铁证 | ✅ codex SDK index.d.ts:83-87 "non-fatal error surfaced as an item" + 用户实测 15 条 loader warning 红 bubble | ErrorItem 无差别 emit error: true，codex CLI 启动期间扫 ~/.codex/agents/*.toml schema 错产生的 loader warning（"Ignoring malformed agent role definition: failed to deserialize ... invalid type: map, expected a string"）被错误投到 user-visible 红 bubble |
| F5 | jsonl-missing fallback 缺 LLM 摘要（codex 端） | INFO/LOW | R1 双方独立提出（reviewer-codex INFO ≈ reviewer-claude LOW） | ❓ 不本轮修 | codex recoverer.ts L29-33 已有 source 注释明示 follow-up 计划（解 shared helper 与 claude MAX_MESSAGE_LENGTH 常量耦合 → 接 codex `summariseCodexSessionForHandOff`） |
| F6 | sdk-bridge.recovery.test.ts archived 并发 unarchive race 测试缺口 | MED test | R2 reviewer-codex 单方 | ✅ test 补缺 | claude recovery test 无 archived case；codex archived 用例仅单条 sendMessage 没让 unarchive 挂起期间发第二条；R1 修法关键路径无回归测试覆盖 → follow-up |
| F7 | codex early-err-cleanup.test.ts ensureCodex / startThread sync throw 路径测试缺口 | LOW test | R2 reviewer-codex 单方 | ✅ test 补缺 | 现有 test 都让 fake Codex 正常返回 ControlledThread，再通过 runStreamed reject 触发 thread-loop earlyErrCb；没执行新增 catch 的早期失败分支 → follow-up |
| F8 | 其他 codex CLI 启动期间高频 loader warning（profile.toml / config.toml schema 错） | INFO *未验证* | R3 reviewer-claude | ❓ 不本轮修 | sandbox 内未能 grep codex-rs 源码现场实测确证；推测两类配置 loader 共用同款错误前缀（典型 Rust serde + thiserror 统一格式）但**未验证**；若用户后续报项可加 pattern 扩展 → follow-up |

**结论**：2 MED（F1+F2 R1）+ 1 HIGH（F3 R2）+ 1 MED（F4 lead 现场）= **4 处 src 必修全 fix** → 详 CHANGELOG_170.md；2 处 test 补缺 + 2 处 follow-up（F5/F8）不阻塞合并。

## reviewer-claude / reviewer-codex 独立 finding 对比

| Finding | reviewer-codex | reviewer-claude |
|---|:---:|:---:|
| archived session unarchive 单飞锁 await 前窗口（双端） | MED ✅ R1 | 漏 |
| codex createSession 早期失败 token / instance 泄漏 | MED ✅ R1 | 漏 |
| codex jsonl-missing fallback 缺 LLM 摘要 prepend | INFO ✅ R1 | LOW ✅ R1（双方共识） |
| claude createSession catch tempKey leak（plan A.4-pre regression） | 漏 | HIGH ✅ R2（含 jsdoc 矛盾佐证 + cross-adapter parity 反证） |
| sdk-bridge.recovery.test 无 archived 并发 unarchive race 用例 | MED test ✅ R2 | INFO ✅ R2（建议 follow-up） |
| codex early-err-cleanup.test 没覆盖 ensureCodex/startThread sync throw | LOW test ✅ R2 | ✅ R2 提到「✅ 已覆盖」但实际不全（reviewer-codex 反证更精确） |
| codex SDK ErrorItem 无差别 emit error: true 污染 UI（用户实测） | 漏 | 漏（lead 现场截图发现） |
| 其他 codex CLI loader warning pattern 覆盖度 | 漏 | INFO *未验证* ✅ R3（follow-up） |

异构互补显著：
- **reviewer-codex** 抓「资源泄漏 + 单飞锁失效 + 测试缺口」（archived unarchive race / createSession early-err leak / test gap 补缺）
- **reviewer-claude** 抓「跨 adapter parity gap + jsdoc 矛盾佐证 + 主动证伪自己 R1 候选 finding」（HIGH-1 catch tempKey leak 与 codex 端正确实施形成反证）
- **lead 现场** 抓「用户截图实测 ErrorItem 红 bubble」（双 reviewer 都漏因为 prompt 没让关注 translate.ts，纯 sdk-bridge focus）

零交叉的部分反映双 reviewer 视角差异（reviewer-codex 5 条 vs reviewer-claude 4 条 vs lead 1 条），符合异构对抗设计意图。

## SKILL 学习点

- **R1 主动证伪自己 finding 候选的价值**：reviewer-claude R1 主动证伪 claude createSession catch sessions Map leak 候选（精确时序追溯：finally always 跑 + double-key clean idempotent），但 R2 broader scope（resource lifecycle 深挖 + cross-adapter parity）反而发现**真**的 sessions Map leak（HIGH-1，不是 R1 候选的同一处但相关）。说明「证伪一个候选不等于证伪整个区域」，多轮挖深仍能挖出新的 race / leak。
- **lead 现场 finding 的合法路径**：用户截图实测出双 reviewer 都漏的 ErrorItem 污染问题。SKILL 没禁 lead 在 review 期间引入新 finding（用户授权 / 现场发现），但需走三态裁决（lead 验证铁证 → ✅ 必修）+ R2/R3 给 reviewer 一并审 fix 收口。这条路径比扩 scope 重 spawn reviewer 成本低 + 速度快。
- **跨 adapter parity gap 是高 ROI 维度**：HIGH-1 通过 reviewer-claude 拿 codex 端正确实施反证 claude 端 bug。SKILL prompt focus 主轴包含「跨 adapter 状态机对称性」时，reviewer 会主动做对照 → 发现 plan A.4-pre §S2 修法引入的 regression。
- **多轮迭代 reviewer 不 shutdown**：本批 R1+R2+R3 三轮跨越 ~30min，双 reviewer 始终保持 active 复用 R1 mental model（reviewer-claude R3 引用「R1 CONFIRMED OK 8 项」+ R2「8 项 PASS」做 R3 收口判定）。符合 SKILL §Step 5「迭代期间绝不 shutdown」invariant。
- **R3 收口判定的契约**：「严格只看本轮 fix-to-fix 范围，不再扩 scope」让 R3 快速 PASS（双方各 ~5min reply），避免无限挖深。配 Round 3 reviewer-codex 总评「R3 两处 fix-to-fix 检查通过，可合；残留项仍限定为已列 follow-up」。

## 验证

- **typecheck**: `pnpm typecheck` 0 error
- **测试**: `pnpm exec vitest run src/main/adapters/claude-code/sdk-bridge/__tests__/ src/main/adapters/codex-cli/sdk-bridge/__tests__/ src/main/adapters/claude-code/__tests__/sdk-bridge.recovery.test.ts src/main/adapters/codex-cli/__tests__/sdk-bridge.recovery.test.ts src/main/adapters/codex-cli/__tests__/sdk-bridge.early-err-cleanup.test.ts src/main/adapters/claude-code/__tests__/sdk-bridge.consume-fork.test.ts src/main/adapters/codex-cli/__tests__/sdk-bridge.consume-fork.test.ts src/main/adapters/codex-cli/__tests__/translate.test.ts` → 16 files / 170 tests pass / 0 fail / 0 error
- **行为零回归**：4 处 fix 都属于「补缺 cleanup / filter」类不改主路径行为，所有现有 test 期望未变

## Follow-up（独立 plan / issue 后续收口）

1. **F5 [INFO/LOW 双方共识]** codex jsonl-missing fallback 缺 LLM 摘要 prepend：解 shared `prependHistorySummary` helper 与 claude `MAX_MESSAGE_LENGTH` 常量耦合 → 接 codex `summariseCodexSessionForHandOff`（codex SDK 不支持 systemPrompt 可用 user message prefix 替代）。已有 codex/sdk-bridge/recoverer.ts:29-33 source 注释 follow-up 计划。
2. **F6 [MED test]** 补 sdk-bridge.recovery.test.ts archived 并发 unarchive race 用例（双端各加一个 test：mock unarchive 返回可控 Promise，先发 'first' message，在 unarchive 未 resolve 时发 'second'，断言 createSession 仍只调用一次 + unarchive 只调用一次 + 第二条等待 first recovery 后走 sendThunk(finalId, ...))。
3. **F7 [LOW test]** 补 codex early-err-cleanup.test.ts 3 个用例：loadCodexSdk reject / resumeThread sync throw / startThread sync throw，分别断言 mcpSessionTokenMap.get(token) === null + codexBySession.has(initialSid) === false + sessions.has(initialSid) === false，resume 场景再断言 releaseSdkClaim(resumeSid) 被调用。
4. **F8 [INFO *未验证*]** 其他 codex CLI 启动期间高频 loader warning pattern（profile.toml / config.toml schema 错等）扩展 LOADER_WARNING_PATTERNS：等用户后续报项再补；codex-rs 源码 grep 确证 pattern 后再扩。

---

## R4 R5 补 split-feasibility 专项 review（单文件大小护栏维度）

R1-R3 focus 漏 cover 单文件大小护栏维度（4 文件 3018 LOC 全部超 500 行 SOP file-size-guardrail 护栏却未触及拆分）。R4 spawn 新一对 reviewer pair（reviewer-claude `572ae891` Opus 4.7 + reviewer-codex `019e6e2c` gpt-5.5 xhigh，新 team `dcr-batch-b-split-20260528`）专项补这一漏。

### R4 三档裁定（双方独立提出 + 分歧合议）

| 文件 | reviewer-codex R4 | reviewer-claude R4 | R5 共识 |
|---|---|---|---|
| A claude index.ts (806) | 档 1 必拆（5 deps 估算） | **档 3 真不能拆**（已抽 12+ helpers + 闭包 ~10 跨段 + jsdoc 占大头） | ✅ R5 双方接受档 3：lead 现场补强论据「整段搬出 helper 实测仍 ~500+ LOC 只换文件不减真复杂度」（reviewer-codex R5 主动接受推翻 R4 档 1 主张） |
| B codex index.ts (1010) | 档 1 必拆（整段搬 createCodexSession） | **档 2 强**（3 处独立 sub-module: resume-path-await + thread-options-builder + create-session-rollback ~188 LOC ~36% 减幅） | ✅ R5 双方接受 reviewer-claude 细粒度 3 helper 优于整段搬出（reviewer-codex R5 接受「每个 helper 单一职责 ≤200 LOC + facade 保留 lifecycle 编排视图」） |
| C claude recoverer.ts (670) | 档 2 抽 4 helper（types + cwd + placeholder + jsonl-exists） | **档 2 弱 borderline**（IIFE 紧凑 + jsdoc 撑大 + 减幅 ~10%） | ✅ R5 共识 polish 候选 follow-up，本轮不做 |
| D codex recoverer.ts (617) | 档 2 抽 4 helper（mirror C + codex-jsonl-exists） | **档 2 强 mirror**（codex-jsonl-fallback + codex-recoverer-messages 镜像 claude，cross-adapter parity 维护漂移成本驱动） | ✅ R5 双方接受 mirror 2 helper trade-off（reviewer-codex R5 接受「跨 adapter 漂移风险最高的文案与 jsonl fallback 收口；剩余抽法属后续体积治理不阻塞」） |

### R4 fix loop（5 helper 抽出）

**A**（claude sdk-bridge/index.ts）：加 §保护清单 jsdoc 60 LOC（7 条不动文件理由，与 hand-off-session.ts L8-22 样板对齐）。

**B**（codex sdk-bridge/index.ts 1010 → 874 LOC -13.5%）：
- `thread-options-builder.ts` (49 LOC): `buildCodexThreadOptions` pure builder 替代 resumeThread/startThread 双分支 spread
- `create-session-rollback.ts` (96 LOC): `runCreateSessionRollback` 4 资源 best-effort idempotent cleanup（与 closeSession L730-L744 模板对齐）
- `resume-path-await.ts` (191 LOC): `awaitResumedThreadStart` Promise 三态状态机（30s timeout + onFirstId + earlyErrCb 4 资源 cleanup）

**D**（codex sdk-bridge/recoverer.ts 617 → 597 LOC）：
- `codex-recoverer-messages.ts` (88 LOC) mirror claude `recoverer-messages.ts`: 3 builder（cwdMissingError / cwdFallbackInfo / jsonlMissingNoSummary）
- `codex-jsonl-fallback.ts` (142 LOC) mirror claude `jsonl-fallback.ts maybeJsonlFallback`: 替代 jsonl-missing fallback 整段（精简版无 LLM 摘要 prepend）

### R5 收口（双方共识 ✅ 可合）

- **reviewer-claude R5**: 7 条 jsdoc 覆盖档 3 全部论据 + 与 hand-off-session.ts 样板对齐 / 5 helper 字面等价于原 inline 详细对比 / 4 路径状态机字面对比 / 4 资源 cleanup 顺序验证 / 0 处 *未验证* 条目
- **reviewer-codex R5**: 0 HIGH/MED/LOW/INFO finding / 接受档 3 立场 / 接受细粒度 3 helper 优于整段搬出 / 接受 mirror 2 helper trade-off / 1 INFO 非阻塞 nit（jsdoc 硬行号偏移，后 polish 修弱化）

### R4 R5 异构互补

- **reviewer-codex R4** 倾向「整段搬出 helper 5 deps 收敛」激进抽法，R5 实测后主动接受推翻
- **reviewer-claude R4** 倾向「档 3 保护清单 + 细粒度抽法」保守，引「整段搬出只换文件不减复杂度」论据驳倒 reviewer-codex 档 1 方案
- **lead 现场实测铁证**：codex 端抽 3 helper facade 仅减 13.5%（不到 reviewer-claude R4 估算 36% 一半），印证 reviewer-claude「整段搬出 ROI 低」判断；同时印证细粒度抽法（3 helper 各单一职责 ≤200 LOC）真减复杂度
- **SKILL 学习点**：R5 reviewer 主动接受推翻自己 R4 立场是良性现象 — 异构对抗的目的不是固守立场而是收敛真知，reviewer 应该被实测数据说服而非教条坚持

### R4 R5 测试覆盖

- typecheck 0 error
- 16 sdk-bridge 文件 / 170 tests pass / 0 fail / 0 error
- 5 helper 字面等价于原 inline（R5 详细对比验证零行为变化）

### R4 R5 修法关联 fix

所有 R4 修法见 [CHANGELOG_171.md](../changelogs/CHANGELOG_171.md)。

### R4 R5 Follow-up（独立 plan / 体积治理后续）

1. **C [档 2 弱 borderline]** claude recoverer.ts 抽 runRecoverySingleFlight（减幅 ~10%，优先级低）
2. **A mild 候选 P1** catch block ~38 LOC 抽 runCreateSessionRollback（减幅 < 5%，不入档 2 阈值）
3. **R4 §C/§D 4 helper 细粒度方案**（recoverer-types / recovery-cwd / recovery-placeholder / codex-jsonl-exists）— reviewer-codex R4 推荐但本轮取 reviewer-claude mirror 2 helper trade-off；4 helper 细粒度方案留作体积治理 follow-up
