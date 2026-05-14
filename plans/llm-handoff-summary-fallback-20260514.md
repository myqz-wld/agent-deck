---
plan_id: "llm-handoff-summary-fallback-20260514"
created_at: "2026-05-14"
worktree_path: "/Users/apple/Repository/personal/agent-deck/.claude/worktrees/llm-handoff-summary-fallback-20260514"
status: "completed"
base_commit: "6273545"
final_commit: "6f23a069f598e92bafa150d6c5cad7f95554e3b5"
completed_at: "2026-05-14"
---
# LLM 摘要 fallback 自动注入(手段 2)

## 总目标 & 不变量

让 `recoverer.ts` 的 jsonl missing fallback / cwdFellBack=true 路径在起 fresh CLI **之前**,自动调 LLM 摘要应用 DB 历史 → prepend 到用户 prompt 前作为 fresh CLI 首条 prompt 的一部分,让用户体感「Claude 还能续聊」(而不是 CHANGELOG_106 兜底「请下条消息把背景告诉它一次」的手动补)。

**不变量**:
- 摘要失败 / DB 没历史 / settings 关闭 → 退回 CHANGELOG_106 已落地的「emit 提示让用户自己补背景」路径,**永不阻塞** fallback 主路径
- 不持久化摘要(一次性 fresh CLI 首条 prompt 用,下次 fallback 重算)
- 不破坏现有 jsonl missing test case 全部断言(noop summarise 注入让原 case 仍 work)
- 仅在 fallback 路径触发(正常 resume 路径 jsonl 在 + cwd 在 不调摘要)

## 设计决策(已确定,不再争论)

1. **复用现成 `summariseSessionForHandOff`**(`src/main/session/summarizer/llm-runners.ts`)— 它本来就为「跨会话/跨 SDK 接力」设计,产出 sonnet 简报(详注释)。不另起 LLM 调用。
2. **触发条件**:`(cwdFellBack || !jsonlExists)` 路径中,prompt 之前调 `summariseSessionForHandOff(sessionId)`。
3. **prompt 拼装**:`[历史摘要]: <summary>\n\n[用户当前消息]: <text>`(明确双段,让 Claude 区分历史 vs 当前 task)。具体格式 Step 2 实操时按 LLM 友好性最终敲定。
4. **失败降级**:LLM 调用 throw / 返 null / 摘要超 MAX_MESSAGE_LENGTH(102_400 chars) → 退回原 fresh prompt(只 user text)+ CHANGELOG_106 emit 提示「请补背景」。**不**阻塞 createThunk。
5. **进度通知**:摘要前 emit `⚠ 正在生成历史摘要传递给 Claude...`(info 性质),摘要成功后 **不**再 emit cwdFellBack 路径的「将丢失」/jsonl missing 路径的「已丢失」(摘要成功 ≠ 丢失,文案矛盾)。摘要失败时 emit CHANGELOG_106 那条「请补背景」。
6. **settings 开关**:`autoSummariseOnFallback: boolean`(default `true`)。允许成本敏感用户关掉。schema 加 + ipc 加 + ExperimentalSection / 类似 section 加 UI toggle(参考 settings 现有写法)。
7. **不动**:正常 resume 路径(cwd 在 + jsonl 在)— 那条路径 CLI 自己 resume jsonl,Claude 看完整对话历史不需要 prepend 摘要。
8. **测试 mock**:summariseFn 通过 ctx 注入(同 createThunk / sendThunk / jsonlExistsThunk / cwdExistsThunk 模式),让单测不调真 LLM。

## 步骤 checklist

- [x] **Step 1** — recoverer ctx + ctor 加 `summariseFn` thunk(参考现有 4 thunk 模式),facade `sdk-bridge/index.ts` ctor 接通 `summariseSessionForHandOff` import (commit `c2c564d` 2026-05-14)
- [x] **Step 2** — 抽 helper `prependHistorySummary(opts): Promise<PrependResult>`,5 种 failReason / 五等号块拼接 / 永不抛错 / caller 决定 emit (commit `7962a11` 2026-05-14)
- [ ] **Step 3** — jsonl missing fallback 路径(`recoverer.ts:270`)调 `prependHistorySummary` 把 prepended prompt 传给 createThunk;成功 → 不 emit「已丢失」(摘要成功 ≠ 丢失);失败 → emit 「已丢失」(原 CHANGELOG_106 文案)
- [ ] **Step 4** — cwdFellBack=true 路径(`recoverer.ts:155-194`)同款集成(把原 emit 「将丢失」改成「成功摘要 → 不 emit / 失败 → emit 将丢失」)
- [ ] **Step 5** — `settings.autoSummariseOnFallback` schema(`shared/types/settings.ts`) + settingsStore 默认值 + ipc set handler + UI toggle
- [ ] **Step 6** — 测试覆盖:摘要成功(verify createThunk prompt 含摘要前缀)/ 摘要失败降级(原 fresh prompt + emit 失败提示)/ DB 无历史(skip 摘要)/ settings off(skip 摘要)/ cwdFellBack 路径同款集成 case
- [ ] **Step 7** — `noopSummarise` 注入到现有 9 case(jsonl missing case + cwdFellBack 3 case + 其他 5 case)防默认走真 summariseFn 撞 DB 未 init 噪音
- [ ] **Step 8** — typecheck + 跑 `sdk-bridge.recovery.test.ts` 全套验证
- [ ] **Step 9** — CHANGELOG_107.md + INDEX.md 加行

## 当前进度

- [x] 用户拍板手段 2 方案(2026-05-14)
- [x] CHANGELOG_106 已 commit `6273545`(bug fix + baton teammate shutdown)
- [x] worktree 创建 `.claude/worktrees/llm-handoff-summary-fallback-20260514`
- [x] plan 文件落 `<main-repo>/.claude/plans/llm-handoff-summary-fallback-20260514.md`
- [x] **Step 1 done** by current session on 2026-05-14, commit `c2c564d` pushed to `origin/worktree-llm-handoff-summary-fallback-20260514`
  - 实操路径:`recoverer.ts` 加 `SummariseFnThunk` type + ctor 第 6 参数(`void this.summariseFn` silence TS6138);`sdk-bridge/index.ts` ctor 接通 + `protected summariseForHandOff` wrapper(双层 wrapper 模式,与 `resumeJsonlExists` / `cwdExists` 对齐);`_setup.ts` TestBridge 加 `summariseOverride: string | null = null` field + override
  - 验证:typecheck 0 错 + sdk-bridge.recovery 9 case 全过(零业务行为变化)
  - **Step 1 边角踩坑**(下次会话不要再踩):worktree 装 deps 时 postinstall 跑 node-gyp rebuild node-pty 因 Python 3.12+ 移除 `distutils` 报错(已知 issue,与本任务无关);electron 二进制 dist 没下成 → 从主 repo `node_modules/.pnpm/electron@33.4.11/node_modules/electron/dist` symlink + `path.txt` cp 过来兜底;**vitest 跑测试不需要 native binding**,绕过即可
- [x] **Step 2 done** by current session on 2026-05-14, commit `7962a11` pushed to `origin/worktree-llm-handoff-summary-fallback-20260514`
  - 实操路径:新增 `src/main/adapters/claude-code/sdk-bridge/recoverer-helpers.ts` (~190 LOC 含 jsdoc) — module-level pure function `prependHistorySummary(opts): Promise<PrependResult>`;5 种 failReason(`settings-off` / `no-events` / `summary-empty` / `over-length` / `thunk-throw`);五等号块拼接;永不抛错(thunk throw 封装在 PrependResult.thrown);caller 看 failReason 决定 emit 哪条文案(本 helper 不直接 emit)
  - 验证:typecheck 0 错 + sdk-bridge.recovery 9 case 全过(零回归;helper 0 caller 等 Step 3/4)
- [ ] **Step 3 起步**(待新会话或本会话续做)

## 下一会话第一步

> Step 1 + Step 2 已完成(2026-05-14, commits `c2c564d` + `7962a11`),下面是 **Step 3 起步**指令。

1. `Bash: cat /Users/apple/Repository/personal/agent-deck/.claude/plans/llm-handoff-summary-fallback-20260514.md`(**严禁** Read tool — 详 user CLAUDE.md §Step 3 cold-start callout)
2. `EnterWorktree(path: "/Users/apple/Repository/personal/agent-deck/.claude/worktrees/llm-handoff-summary-fallback-20260514")` 进 worktree
3. (自检)`Bash: pwd` 应含 `.claude/worktrees/llm-handoff-summary-fallback-20260514`
4. (自检)`Bash: git log --oneline -3` HEAD 应是 commit `7962a11` 或之后
5. **Step 3 实操**:接 jsonl missing fallback 路径(`recoverer.ts:270` 之后 `if (cwdFellBack || !this.jsonlExistsThunk(...))` 分支内 `if (!cwdFellBack) { console.warn + emit「请补背景」 + ... }`),把 createThunk 调用包一层 prependHistorySummary
   - **顺序决策**:Step 3 / Step 4 / Step 5 强耦合(都要读 settings);**建议先做 Step 5**(settings 字段全栈接通)再做 Step 3/4(直接 `settingsStore.get('autoSummariseOnFallback')`,免占位 true 后改),顺序变成 5 → 3 → 4 → 6 → 7 → 8 → 9。如果 Step 3/4 先做就用占位 `true` 做(Step 5 后 grep 替换);两种顺序都 OK,Step 5 commit 边界更干净建议优先
   - **Step 3 改动清单**(假设按 plan 原顺序 Step 3 在前):
     - recoverer.ts 加 `import { eventRepo } from '@main/store/event-repo';`
     - recoverer.ts 加 `import { prependHistorySummary } from './recoverer-helpers';`
     - L270 `if (cwdFellBack || !this.jsonlExistsThunk(effectiveCwd, sessionId)) {` 进入分支后:在 createThunk 之前调 `await prependHistorySummary({ sessionId, originalText: text, cwd: effectiveCwd, autoSummariseOnFallback: true /* Step 5 替换为 settings */, summariseFn: this.summariseFn, listEventsFn: (sid) => eventRepo.listForSession(sid) })`
     - 拿到 `result: PrependResult`:
       - `result.used === true` → createThunk 用 `result.prompt`,**不** emit「请补背景」(L288-301 那段);可选 emit 一条 info 「⚠ Claude 通过应用历史摘要恢复了上下文(...)」让用户知道发生了什么(Step 3 实操时定文案)
       - `result.used === false` → createThunk 用 `text` 原 prompt,emit CHANGELOG_106 「请补背景」原文案(保留 L288-301)
   - **测试预防**:Step 3 commit 时,sdk-bridge.recovery jsonl missing case (L189-238) 默认 `summariseOverride = null` 走 fallback 路径 → `result.used = false` → 仍 emit「请补背景」 → 现有断言不破。新「摘要成功」case 在 Step 6 加
6. Step 3 完成 typecheck 0 错 + 测试零回归后 commit atomic
7. 然后 Step 4(cwdFellBack=true 路径 L155-194 同款集成,但**注意**:cwdFellBack 路径 emit 的「将丢失」文案应改成「成功 → emit 「Claude 通过摘要恢复 + 已 fallback 到 X cwd」/失败 → 保留原「将丢失」」;两条文案合并思路 Step 4 实操时定)
8. 最后 Step 5(settings 字段全栈)→ Step 6(测试)→ Step 7(noopSummarise 注入,但 Step 1 已加 `summariseOverride = null` 默认,可能 Step 7 已被覆盖,Step 6 时再决定)→ Step 8(全 typecheck + vitest)→ Step 9(CHANGELOG_107)

## 关键文件路径(全部 worktree 绝对路径,严禁用主 repo 绝对路径)

prepend `<worktree-abs-path>/` = `/Users/apple/Repository/personal/agent-deck/.claude/worktrees/llm-handoff-summary-fallback-20260514/` 后使用:

- `src/main/adapters/claude-code/sdk-bridge/recoverer.ts`(主战场,加 ctx field + helper)
- `src/main/adapters/claude-code/sdk-bridge/index.ts`(facade ctor 接通)
- `src/main/session/summarizer/llm-runners.ts`(复用 summariseSessionForHandOff,**只读不改**)
- `src/main/adapters/claude-code/__tests__/sdk-bridge.recovery.test.ts`(测试新 case + noopSummarise 注入)
- `src/shared/types/settings.ts`(autoSummariseOnFallback 字段)
- `src/main/store/settings-store.ts`(default 值)
- `src/main/ipc/settings.ts`(set handler 透传)
- `src/renderer/components/settings/sections/ExperimentalSection.tsx`(UI toggle,如复用)

## 已知踩坑(CHANGELOG_106 教训迁移)

1. **test default 调用点必须主动注入 mock summariseFn** — 同 CHANGELOG_106 noopShutdown 模式,否则原 9 case 默认走真 summariseFn 撞 DB 未 init / 真起 sonnet 调用计费
2. **emit 文案不互相冲突** — 摘要成功 → 不 emit「将丢失/已丢失」(否则用户看到「丢失警告 + Claude 答得对」迷惑);摘要失败 → emit CHANGELOG_106 文案(原版 fallback)
3. **settings 加新字段必须双端同步** — schema(shared)+ store default + ipc set handler + UI 三处全改,否则「能改但不生效」(详 project CLAUDE.md `§ipc.ts SettingsSet handler 是即改即生效中转点`)
4. **summariseSessionForHandOff 失败语义不明** — Step 1 必须先 Read llm-runners.ts 确认它 throw / return null / 部分失败;按它的契约设计 prependHistorySummary 内部 try/catch
5. **不用 plan 接力默认 cwd** — `hand_off_session` plan-driven 模式 default cwd = mainRepo(CHANGELOG_99 cwd resilience),新 session 自己 EnterWorktree(path) 进 worktree 干活;**严禁**让新 session 在 main repo 做改动(会污染主分支)
