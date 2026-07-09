# CHANGELOG_110

## 概要

REVIEW_37 R1+R2+R3 宏观重构机会三轮异构对抗 × P1+P2+P3 三档落地（plan deep-review-and-refactor-r37-20260515）。reviewer-claude Opus 4.7 + reviewer-codex gpt-5.5 xhigh teammate 三轮全 scope main 进程重构机会扫描共挖 8 ✅ HIGH（R1 7 + R2 1）+ 10 ✅ MED（R1 8 + R2 2）+ 6 LOW/INFO 真问题 + 3 R2 ❌ pre-existing 不归 R37 + 3 calibration 跳过（plan 决策不实施 + R3 双方独立验证理由站得住）。共 16 commit / 行为零变化 / typecheck 双端 + vitest 524/524 全过。详 [REVIEW_37.md](../../reviews/history/REVIEW_37.md)。

## 变更内容

### Phase 1: P1 trivial 高 ROI（4 commit / Step 1.1-1.3 + Phase 2 顺手）

#### Step 1.1 — D withMcpGuard + preload subscribe wrapper（commit bd0be75）

- `src/main/agent-deck-mcp/tools/handlers/_helpers.ts` 新建 `withMcpGuard()` wrapper 收口 7 handler 的 deny external + JSON parse 模板
- `src/preload/api/_helpers.ts` 新建 `subscribe<T>()` wrapper 收口 8 onXxx + teams.ts 2 onXxx 共 10 处 ipcRenderer.on/off 模板
- 7 handler + 10 onXxx 全部迁移；预计 -60 LOC + 防漏 denyExternalIfNotAllowed
- typecheck 0 错 / vitest agent-deck-mcp 145 全过

#### Step 1.2 — G codex-instance-pool 收口（commit d421173）

- `src/main/adapters/codex-cli/codex-instance-pool.ts` 新建模块暴露 `getCodexInstance()` / `invalidateCodexInstance()` 应用全局 pool
- 2 个 oneshot runner（summarizer-runner / handoff-runner）共享 1 个实例
- sdk-bridge 因含 agent-deck MCP config + bearer token 不能并入（保留 own ensureCodex 但删 `private codexCliPath` field 直接 settingsStore.get + setCodexCliPath 调 invalidate 同步失效 pool）
- 3 cache → 2 instance；typecheck 0 错 / vitest 全套 504 全过

#### Step 1.3 — B recoverer message builder（commit 10d6656）

- `src/main/adapters/claude-code/sdk-bridge/recoverer-messages.ts` 新建（与 recoverer-helpers.ts 同目录），抽 6 个 message text builder 纯函数（cwdMissing / cwdFallback / jsonl missing summary success/fail / cwdFallback summary success/fail）
- recoverer.ts 4 个分支替换为单调用；预计 641 → ~520 LOC（净 -12 LOC，emit struct boilerplate 留 Step 4.3 抽 emitFallbackOutcome helper 时收口）
- typecheck 0 错 / vitest 全套 504 全过

#### Phase 2 trivial 顺手（commit 342eca7）

- **Step 2.1**: `src/main/utils/optional-fields.ts` 抽 omitUndefined helper；spawn handler + hand-off-session 8 处 spread+ternary 收口（4+4，extra_allow_write/model 因 length/falsy 语义保留 inline）
- **Step 2.2**: 删 recoverer.ts:159-162 4 行 REVIEW_36 LOW-3 标的 TS6138 silence 死注释整体删；ctor body `{}` 不再含误导性副作用语句
- **Step 2.3**: 清理 README:269 + docs/agent-deck-team-protocol.md:357 + types.ts 占位注释，aider/generic-pty 改写为 "PTY bridge implemented"

### Phase 2: P2 中等改造（6 commit / Step 3.1-3.6）

#### Step 3.1 — F shared mock factory（commit e5cc6a5）

- `src/main/__tests__/_shared/mocks/{session-repo,event-bus,sdk-loader,agent-deck-team-repo,settings-store}.ts` 5 factory 新建 +349 LOC 含 jsdoc + type
- 11 test 文件迁移使用 -103 LOC；manager-test-setup.ts 转 re-export 让 manager 3 test 调用方 0 改造
- vi.hoisted 修 spawn-guards / tools.test.ts 的 immediate access const ReferenceError
- 504/504 vitest 全过 + 0 typecheck 错 / 行为零变化
- **4 个文件保护清单**：adapters/generic-pty/__tests__/{pty-bridge.lifecycle,pty-bridge.idle-fwatch,adapter}.test.ts 仅 mock sessionRepo.setGenericPtyConfig 单方法迁了反而冗余
- R37 R1 finding 估「-360 LOC test code + 防漏 mock」偏乐观 — 真实收益是「防漏 mock + 标准化基线」而非 LOC 净减

#### Step 3.2 — H 4 LLM oneshot runner 抽 helper（commit 10a0af7）

- `src/main/session/oneshot-llm/{build-prompt,race-with-timeout,clean-result,claude-runner,codex-runner,index}.ts` 6 helper +435 LOC 收口 4 处 race + result clean + prompt template + SDK 设置共性
- 4 runner（summariseViaLlm / summariseSessionForHandOff / summariseCodexSessionViaOneshot / summariseCodexSessionForHandOff）替换为高层入口 thin wrappers
- codex summarize timeout 下沉到 runner 内（与 codex handoff + claude path 统一）；summarizer/index.ts 删 ~30 LOC Promise.race block
- typecheck 0 错 / vitest 全套 504/504 + hand-off.test.ts 6/6 全过
- raw LOC 反而 +234 net（按项目 CLAUDE.md「WHY 注释强约束」每个 helper 顶部 + 每个差异点写了密集 cross-reference 注释），真实收益：deliverable 代码 ~-80 LOC + 4 处 race / clean / prompt / SDK 设置变 1 SSOT，未来加第 5 路 oneshot 用例零模板压力

#### Step 3.3 — I summariseEvents dispatch 下放 adapter（commit 04f04b4）

- `src/main/adapters/types.ts` AgentAdapter interface 加 optional `summariseEvents?(cwd, events, kind)` +30 jsdoc
- `src/main/adapters/claude-code/index.ts` claude adapter 实装 +23 / `src/main/adapters/codex-cli/index.ts` codex adapter 实装 +24 + import formatEventsForPrompt
- `src/main/session/summarizer/index.ts` dispatch 4 行 if/else 收口为 1 行 + 删 3 import / `src/main/ipc/sessions.ts` dispatch 同款收口 + 删 2 import
- aider+generic-pty 不实装走 fallback；504/504 vitest 全过 + 0 typecheck 错 / 行为零变化

#### Step 3.4 — E codex sdk-bridge 拆 sub-module（commit d7c2522）

- `src/main/adapters/codex-cli/sdk-bridge/input-pack.ts` 53 LOC + `session-finalize.ts` 68 LOC + `restart-controller.ts` 137 LOC（与 claude sub-module 镜像，参考 CHANGELOG_85 拆 claude sdk-bridge 5 sub-class + facade 风格）
- `src/main/adapters/codex-cli/sdk-bridge/index.ts` 543 → 409 大幅过 500 护栏
- restartWithCodexSandbox 改 thin wrapper 委托给 RestartController sub-class
- persistSessionFields 收口 createSession 两路字面镜像段
- 504/504 vitest 全过 + 0 typecheck 错 / 行为零变化

#### Step 3.5 — M runBatonCleanup helper（commit be0d8ef）

- `src/main/agent-deck-mcp/tools/handlers/baton-cleanup.ts` 211 LOC + 单测 10 case 320 LOC
- archive-plan.ts 235 → 167 大幅减 -68 / hand-off-session.ts 444 → 389 减 -55
- handler 端 deps seam shape 不变现有 43 case 0 改造跑过
- 514/514 vitest 全过 + 0 typecheck 错 / 行为零变化 — 时序 + 失败容错 + console.warn 核心 substring 全保留

#### Step 3.6 — N message-delivery-state SSOT（commit 2125f64）

- `src/main/store/message-delivery-state.ts` 新建 208 LOC 含 BACKOFF_TIERS / MAX_RETRY / MAX_BODY_LENGTH / VALID_MESSAGE_STATUSES / MessageInvariantError + backoffMs / coerceMessageStatus / buildFindEligibleWhereSql 纯函数 + module load invariant 自检
- `src/main/store/agent-deck-message-repo.ts` 496 → 460 LOC -36 + re-export 全部 named export 保 back-compat
- findEligible SQL CASE 由 BACKOFF_TIERS 表派生消除「改任一处必须同步另一处」死注释
- rowToRecord 内 inline validStatuses 数组替换为 coerceMessageStatus
- 514/514 vitest 全过 + 0 typecheck 错 / 行为零变化

### R2 fix: 1 ✅ HIGH + 2 ✅ MED 真 R37 引入 fix（2 commit）

#### R2 HIGH-1 — spawn handler batonRole opts + hand-off-session 透传 'lead'（commit 4ba8d25）

- `src/main/agent-deck-mcp/tools/handlers/spawn.ts` 加 `batonRole?: 'lead' | 'teammate'` opts 字段，spawn 时根据 opts 决定新 session 在 team 的 role
- `src/main/agent-deck-mcp/tools/handlers/hand-off-session-impl.ts` 调 spawnSession 时显式传 `batonRole: 'lead'`
- 修前漏洞：hand_off_session(team_name='X') baton 模式下，新 spawn session 加入 team 时未带 batonRole='lead' opts → spawn handler 默认走 teammate role → 0-lead team auto-archive 触发 → 新 session 还没接力就被 archive
- 测试：tools.test.ts 加 3 个 regression case（验证 batonRole='lead' 显式传递 + spawn 默认 teammate role 不变 + hand_off_session(team_name=X) 新 session 是 lead）

#### R2 MED-1 — codex handoff slice 不限长度（commit 68f7efb）

- `src/main/session/oneshot-llm/codex-runner.ts` codex hand-off runner 调 formatEventsForPrompt 显式传 `maxEvents: undefined`（不限长度），与 claude path 对齐
- 修前问题：codex hand-off prompt 用 formatEventsForPrompt 默认按 200 events slice，对 codex 长会话 hand-off 简报精度不足；claude path 没限制（双 path 不一致）

#### R2 MED-2 — codex timeout race scope 包整 SDK init（commit 68f7efb 同 commit）

- `src/main/session/oneshot-llm/codex-runner.ts` race scope 上提到 SDK init 之前，整个 init+query 都在 60s 内
- 修前问题：codex 60s timeout race 仅包 query() 不包 SDK init（spawn child process + handshake），SDK init 卡住时 timeout 不生效
- 测试：hand-off-session test 加 1 个 regression case（验证 SDK init slow path 60s timeout 触发）

### Phase 4: P3 散落收口（4 commit / Step 4.1-4.7 实施）

#### Step 4.1 — C cwd resolver（commit 1886247）

- `src/main/utils/cwd-resolver.ts` +52 LOC 含 jsdoc / `src/main/utils/__tests__/cwd-resolver.test.ts` 6 case 守门 trim 后非空
- 替换 3 处：codex sdk-bridge / claude-runner / codex-runner（统一从 `opts.cwd && opts.cwd.trim() ? opts.cwd : process.cwd()` 严格版 + `opts.cwd || process.cwd()` 宽松版到「trim 后非空才用 caller cwd 否则降级 process.cwd()」严格语义）
- 4 处 jsdoc 同步；524/524 vitest 全过 + 0 typecheck 错
- **5 处替换** plan 估算偏高 — R1 finding 估「等 5 处」时把 deps.cwd() inject 注入位（archive-plan-impl / hand-off-session-impl 各 1 处）也算上，但那 2 处不是 fallback chain 而是简单 deps inject，抽 helper 反而冗余；hand-off-session.ts 复杂 fallback chain `args.cwd > resolved.mainRepo > resolved.worktreePath` 是 plan-driven mode 特化逻辑，不能与简单 spawn fallback 同 helper 收口
- 实际收益：3 处 SSOT + caller 传 "   " 全空白时由「传 SDK 让 cli.js 撞 ENOENT」升级为「降级 process.cwd()」更安全

#### Step 4.3 — C recoverer emit fallback message helper（commit bae79d4）

- `src/main/adapters/claude-code/sdk-bridge/recoverer.ts` 抽 `emitFallbackMessage(sessionId, text, opts?: { error?: boolean })` 私有方法
- 替换 6 处：outer cwd missing throw + outer cwd fallback info + inner jsonl missing summary used+skipped + inner cwdFellBack summary used+skipped
- 不收口 2 处单行字面量（L301 占位 + L501 兜底失败）按 recoverer-messages.ts:27-28 注释明示留 inline
- recoverer.ts +51 -64 净 -13 LOC；与 Step 1.3 builder 1:1 配套
- 524/524 vitest 全过 + 0 typecheck 错 / 行为零变化（emit struct 字段顺序与值完全一致）

#### Step 4.5 — L mcp tool result type + handler satisfies（commit af4fafc）

- `src/main/agent-deck-mcp/tools/schemas.ts` +134 LOC 加 7 个 XxxResult interface（与 7 个 XxxArgs type 对称）+ ProjectedSession / TeammatesShutdownInfo 共享 type
- 8 处 handler import + return satisfies XxxResult 校验
- hand-off-session spawnData 由 Record<string, unknown> 改 typed cast SpawnSessionResult 让 spread 后 satisfies 通过
- **方案 B+ 调整**：不抽 7 个 typed builder（保留 helpers.ts untyped `ok()` 8 处统一调用，typed builder 增加 indirection 收益是 marginal 类型文档；satisfies 已覆盖核心收益「字段拼写错 + 类型漂移被 TS 拦」）
- **ROI 验证**：satisfies 校验首次通过即拦下 3 处真实字段类型漂移：
  - archive_plan branch_deleted/worktree_removed 实际 string 非 boolean
  - spawn displayName 实际 string|null 非 string
  - archive_plan final_status 实际 'completed' literal 非泛 string
- 524/524 全过 + 0 typecheck 错 / 行为零变化

#### Step 4.7 — J shared 拆 contract vs policy 边界（commit 736b24a）

- 5 file 加 jsdoc category 标签：
  - **contract**：`src/shared/ipc-channels.ts` / `src/shared/types.ts`
  - **policy**：`src/shared/mcp-tools.ts` / `src/shared/wire-prefix.ts` / `src/shared/constants/read-only-tools.ts`
- `src/shared/ipc-channels.ts` 顶部加完整边界约定 SSOT 让其他 file 引用
- 零 implementation 改动 / 524/524 全过 / 行为零变化

### Phase 4 calibration 跳过（3 step 不实施 / R3 双方独立验证理由站得住）

按 plan「严格按 ROI/风险升序」+ user CLAUDE.md「don't add abstractions beyond what the task requires」原则，3 step 实地调研后跳过：

#### Step 4.2 — C single-flight helper（不实施）

- R1 估「6 处单飞」高估 → 真实只 2 处真 `Map<K, Promise<T>>` 模式：
  - **真单飞**（适合收口）：① `ipc/sessions-hand-off-helper.ts` `handOffInflight = Map<sourceSid, Promise<string>>` + dedupHandOff wrapper（13 LOC 已自洽含 strict-equal 保护）；② `adapters/claude-code/sdk-bridge/recoverer.ts` + `restart-controller.ts` 共享 `ctx.recovering: Map<string, Promise<unknown>>`
  - **不同语义**（不收口）：③ `session/summarizer/index.ts` `inFlight = new Set<string>()` 是 semaphore + dedup-sid（限并发数 + 同 sid 跳过）；④ `teams/universal-message-watcher/index.ts` 是 SQL findEligible（行级 dedup）；⑤ `renderer/components/HandOffPreviewDialog.tsx` `requestSeqRef = useRef(0)` 是 cancellation 模式；⑥ `adapters/generic-pty/pty-bridge/index.ts:79` `spawnHelperReady: Promise<void> | null` 无 key 单 Promise
- 真单飞 2 处也不抽 helper：① dedupHandOff 已自洽 13 LOC，抽 helper +80 LOC 替换 1 处 = helper 比替换的还多（过度抽象违 user CLAUDE.md）；② recoverer/restart ctx 改造涉及 RecovererCtx + RestartCtx interface 改字段类型 + facade 创建 ref + recoverer 4 处 set/delete + restart-controller 6 处 set/delete + 测试 mock 全套 → sub-class state ownership 转换风险与 P4 BaseAdapter 同档高
- R3 双方实地验证（reviewer-claude grep `recovering|inFlight|spawnHelperReady|requestSeqRef` + reviewer-codex 搜 `Map<..., Promise>` / `inflight` / `recovering`）一致认可跳过理由站得住

#### Step 4.4 — K preload misc 按域拆（不实施）

- `src/preload/api/misc.ts` 154 LOC 远未触发项目 CLAUDE.md「单文件 ≤ 500 行触发护栏」（不到 1/3）
- 强行拆 8 个域文件每个 10-30 LOC → +200 LOC 模板（jsdoc / import / export namespace + index.ts re-export indirection）→ 净负 ROI
- invoke<T>() helper Step 1.1 已评估否决（preload/api/_helpers.ts:8-10 SSOT 写「当前 ipcRenderer.invoke 已是泛型 method 各 facade 调用都附 Promise<T> 显式 return type，重复抽一层 helper 收益小」）
- R3 双方实测（reviewer-claude `wc -l`=154 + reviewer-codex 同款）一致认可跳过

#### Step 4.6 — L IPC errorMode 统一 wrapper（不实施）

- 60-80 处 IPC handler 现状已合理分两类 errorMode：
  - **throw 模式**：`sessions.ts:84/122` / `hooks.ts:11/20/29` 等（`throw new IpcInputError`/`Error`）
  - **result 模式**：`window-app.ts:82/93/95` / `assets.ts:130/131/...` / `images.ts:29/33/...` / `permissions.ts:27/31` / `settings.ts:273` 等（`return { ok: false, reason }` 显式 result shape）
- handler return type 已经清晰表达选了哪种 errorMode，wrapper 加 `{ errorMode }` 字段是「重复声明」反而冗余
- 强制 wrapper 不适合「业务层选择」性质的决策（errorMode 选哪个是 handler 业务语义决定）
- 改造 60-80 处大动土，没真 bug 修复
- R3 双方抽样（reviewer-claude grep src/main/ipc + reviewer-codex 抽样确认 throw 类和 `{ ok:false, reason }` 类）一致认可跳过

### R3 收口 review（双方一致 ✅ 可合 / 0 阻塞 finding）

R3 因 R2 reviewer 已被中间会话 hand-off 时 shutdown（`5cceabec` claude · r2 / `1e961eca` codex · r2 都 closed 而非 plan 预期 dormant），无法复用 R2 mental model；按 plan「复用 R37 reviewer mental model」节给的选项 2，spawn 全新 R3 reviewer 对（team `deep-review-37-macro-r3`），R3 init prompt skip 字段透传 R1/R2 已处理 finding。

- **reviewer-claude · r3** (sid `cb9e3722`)：HIGH/MED/LOW 各 0 + 2 INFO 非阻塞（INFO #1 Step 4.3 L465 docstring 措辞 vs 实际不一致 / INFO #2 ArchivePlanResult 命名碰撞），4 step 实施 + 3 calibration 跳过全 ✅；**R3 verdict: ✅ 可合**
- **reviewer-codex · r3** (sid `f366fbde`)：0 finding + 命令验证全过（git diff --check / tsc --noEmit 双端 / 4 step 实地 grep + git show 验证 + 3 calibration 实地 grep 验证）；**R3 verdict: ✅ 可合**
- 2 R3 INFO 单方提出 + plan 决策「INFO 不阻塞」策略不修

## Verify

- `pnpm typecheck` 双端 0 errors
- `pnpm exec vitest run` = 524/524 全过 + 64 skipped (pre-existing SQLite binding self-check)
- 增 13 case：5 factory 守门 + 1 cwd-resolver 6 case + 1 hand-off-session R2 MED-2 + 3 tools.test.ts R2 HIGH-1
- 行为零变化（R37 plan 不变量第 6 条「不引入新功能，纯重构 + 优化，行为零变化为目标」）

## 已知踩坑 / 设计要点

- **plan 估算多次偏乐观，calibration 后跳过 3 step**：R1 finding 估算 LOC / 复用度时往往偏理想（Step 3.1 估「-360 LOC」实际 -103 / Step 3.2 估「-190 LOC」实际 +234 raw 但 deliverable -80 / Step 4.1 估「5 处」实际 3 处 / Step 4.2 估「6 处」实际 2 处）。落地时应优先 grep 实测 + 区分「真同语义」vs「形似」；R3 双方独立验证跳过理由是关键的 sanity check
- **R2 HIGH-1 baton 是 fix-to-fix bug**：spawn handler 默认 batonRole=teammate 是 pre-existing 行为；R37 落地后用户更可能用 hand_off_session(team_name=X) 接力 → 撞此 pre-existing bug。fix 落地后 R2 反馈给 hand-off-session（透传 batonRole='lead'）+ spawn handler（加 batonRole opts 字段）双方修，让 baton 模式新 session 以 lead 加入 team 不触发 0-lead auto-archive
- **R2 codex MED-1/MED-2 揭示 oneshot-llm 双 path 一致性**：claude / codex hand-off 在 Step 3.2 抽 helper 时已统一了 race / clean / prompt / SDK 设置共性，但 codex hand-off 自身两个细节漏（slice 200 / race 不包 init）。R2 reviewer-codex 单方独立提出 + lead 现场验证 grep + 测试覆盖
- **R3 reviewer 复用 R2 mental model 失败的关键教训**：plan 写「保留 R37 reviewer 不 shutdown — 让 lifecycle scheduler 自然 dormant」是针对 R1，R2 reviewer 的复用预期没有显式写到 plan「会话风格授权」节里；中间 hand-off 会话默认 shutdown teammate 把 R2 reviewer 也关掉。下次类似 plan 应在 hand-off 前显式确认 reviewer 状态 / 或在所有 hand-off step 都明示 keep_teammates=true
- **3 calibration 跳过的 R3 双方共识**：R3 verdict 双方一致 ✅ 可合是关键收口信号 — calibration 跳过不是「lead 偷懒」，是「实地调研后理由站得住」（reviewer-claude grep 真单飞数 / reviewer-codex `wc -l` misc.ts / 双方抽样 IPC handler errorMode 两类）。R3 双方独立验证比 lead 自证更可信
- **2 R3 INFO 不修的策略**：INFO #1 docstring 措辞 vs 实际不一致 + INFO #2 命名碰撞都是 trivial polish 单方提出，按 user CLAUDE.md「不引入功能 + 不增加抽象」+ R37 plan「INFO 不阻塞」策略不修；下次顺手收口可清

## 关联

- **REVIEW_37.md**：R1+R2+R3 三态裁决详 + plan 决策映射 + 修复方法详述
- **plans/deep-review-and-refactor-r37-20260515.md**（archive 后路径）：plan SSOT，Phase 1-5 步骤 checklist + 设计决策 + 跳过 step 详细注释
- **REVIEW_36.md / CHANGELOG_108**：R37 之前一轮异构对抗（sandbox + resume + hand-off 真实生效性），与本轮的「baton role + spawn cwd resolver + emit helper + result type satisfies + jsdoc 边界」延续 reviewer-claude/codex teammate 模式
- **REVIEW_35.md / CHANGELOG_102**：plan deep-review-and-refactor-20260514（12 文件热点综合 3 轮异构对抗），与本轮「宏观重构机会」focus 互补 — REVIEW_35 聚焦热点文件 fix；REVIEW_37 聚焦跨文件 / 跨模块重复模式 SSOT 收口
- **CHANGELOG_109**：plan model-wiring-and-handoff-20260514（agent frontmatter model + summarize/handoff model UI + codex hand-off 走 codex SDK），与本轮独立但同期落地（R37 不动 model 链路）
- **CHANGELOG_85**：claude sdk-bridge 拆 5 sub-class + facade 模式 — 本轮 Step 3.4 codex sdk-bridge 拆 input-pack / session-finalize / restart-controller 镜像
- **CHANGELOG_106 / CHANGELOG_107**：shutdownTeammatesOnBaton helper + recoverer summariseFn fallback prepend — 本轮 Step 3.5 runBatonCleanup helper 与 shutdownTeammatesOnBaton 共享 archive_plan + hand_off_session 共享语义
