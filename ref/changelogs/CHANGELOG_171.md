# CHANGELOG_171 — Deep-Review 批 B R4 split refactor (sdk-bridge 双端单文件大小护栏 + cross-adapter parity)

## 概要

[REVIEW_60.md](../reviews/REVIEW_60.md) §R4 补 split-feasibility 专项 review (R1-R3 漏 cover 单文件大小护栏维度) 5 轮异构对抗收口 — A 保护清单 + B 3 helper + D 2 helper 共 5 文件 refactor。零功能变更纯 LOC / cross-adapter parity 治理。

## 修法

### A [INFO] claude sdk-bridge/index.ts 加 §保护清单 jsdoc (file-size-guardrail SOP §档 3)

`claude-code/sdk-bridge/index.ts` ClaudeSdkBridge class jsdoc 内加 7 条不动文件理由保护清单 (`L72-L102` 60 LOC 注释,与 hand-off-session.ts L8-22 样板对齐):

1. createSession 主体已抽 12+ helpers (CHANGELOG_52 Step 3a-3g 列名)
2. 闭包持 ~10 个跨段共享 ref (tier-2 抽 sub-method 需打包 args dict 反降可读性)
3. canUseTool 闭包注入 6 deps + PermissionResponder 双向强耦合
4. sessions Map / sdkOwned 集合 / pendingMessages 三状态强耦合
5. 4 protected wrappers 作 test seam 必须挂 facade class 上
6. plan reverse-rename-sid-stability §A.4-pre S2-S9 行号 reference
7. catch block mild 候选 P1 减幅 < 5% 不入档 2 阈值「30%+ 减幅」

**理由**: reviewer-claude R4 档 3 主张 + lead 现场补强论据「整段搬出 helper 实测仍 ~500+ LOC,只换文件不减真复杂度」(reviewer-codex R4 档 1 主张被实测推翻 — codex 端抽 3 helper facade 仅减 13.5%,claude 已最大化抽出 ROI 更低);R5 reviewer-codex 接受「转移复杂度而不是降低复杂度」。

### B [MED] codex sdk-bridge/index.ts 抽 3 helper (1010 → 874 LOC, -13.5%)

reviewer-claude R4 §B 推荐细粒度抽法 (优于 reviewer-codex R4 整段搬出 createCodexSession 方案):

- **`thread-options-builder.ts buildCodexThreadOptions`** (49 LOC):pure builder 替代 resumeThread/startThread 双分支 spread 字面重复 (原 L499-L526 ~28 LOC)。零闭包零 side effect,test seam 低成本。
- **`create-session-rollback.ts runCreateSessionRollback`** (96 LOC):4 资源 best-effort idempotent cleanup (codexBySession.delete + tokenMap.release + sessions.delete + 条件 releaseSdkClaim) 替代 catch block (原 L774-L813 ~40 LOC)。与 closeSession L730-L744 模板 + REVIEW_60 R3 reviewer-claude PASS「三层 cleanup idempotent 设计」一致。
- **`resume-path-await.ts awaitResumedThreadStart`** (191 LOC):Promise 三态状态机 (30s timeout / onFirstId / earlyErrCb 4 路径) 替代 resume path inner Promise (原 L609-L729 ~120 LOC)。resolved 标志 + clearTimeout 互斥语义 + earlyErrCb 4 资源 cleanup + path 1 (30s 内) vs path 2 (late) emit 差异保留。

facade index.ts 1010 → **874 LOC** (-136 LOC -13.5%) 入档 2 阈值「30%+ 减幅」。

### D [MED] codex recoverer.ts 抽 2 helper mirror claude (cross-adapter parity 维护单点)

reviewer-claude R4 §D 推荐 mirror 抽法 (优于 reviewer-codex R4 4 helper 细粒度方案,选 cross-adapter parity 优先):

- **`codex-recoverer-messages.ts`** (88 LOC) mirror claude `recoverer-messages.ts`:3 builder 替代 inline emit text:
  - `buildCodexCwdMissingErrorText(badCwd)` (替代 L271-L273)
  - `buildCodexCwdFallbackInfoText(badCwd, fallbackCwd)` (替代 L296-L300)
  - `buildCodexJsonlMissingNoSummaryText()` (替代 L383-L385)
- **`codex-jsonl-fallback.ts maybeCodexJsonlFallback`** (142 LOC) mirror claude `jsonl-fallback.ts maybeJsonlFallback`:替代 jsonl-missing fallback 整段 (原 L373-L418 ~46 LOC)。Ctx/Opts/Result discriminated union 接口形态镜像 claude;精简版无 LLM 摘要 prepend (F5 follow-up)。

facade recoverer.ts 617 → **597 LOC** (-20 LOC)。

**最大动机**: cross-adapter parity 维护漂移成本 — 改 claude `recoverer-messages.ts` builder (如调整 cwd fallback 文案) 时不再需要 sync codex inline text;同款 jsonl fallback 逻辑两份独立维护改成 mirror 单点。

## 验证

- `pnpm typecheck` 0 error
- `pnpm exec vitest run` 16 sdk-bridge 文件 / 170 tests pass / 0 fail / 0 error
- 5 helper 字面等价于原 inline (reviewer-claude R5 详细字面对比验证 + reviewer-codex R5 接口签名核查 + 4 路径状态机字面对比 + 4 资源 cleanup 顺序验证)
- 零功能变更 — 纯 refactor 不改主路径行为,所有现有 test 期望未变

## R4 R5 reviewer 共识

- A: 双方共识档 3 ✅ (reviewer-codex R4 档 1 主张 R5 接受推翻)
- B: 双方共识 3 helper 实施 ✅ (reviewer-codex R4 整段搬出方案 R5 接受细粒度优于)
- D: 双方共识 2 helper mirror ✅ (reviewer-codex R4 4 helper 细粒度方案 R5 接受 mirror trade-off)

## Follow-up

详 [REVIEW_60.md](../reviews/REVIEW_60.md) §Follow-up + R4 §Plan 建议:
1. **C [档 2 弱 borderline]** claude recoverer.ts 抽 runRecoverySingleFlight (减幅 ~10%,优先级低,polish 候选)
2. **A mild 候选 P1** catch block ~38 LOC 抽 runCreateSessionRollback (减幅 < 5%,不入档 2 阈值)
3. **F5 [INFO/LOW]** codex jsonl-missing fallback 缺 LLM 摘要 prepend (独立 plan 收口)
4. **R4 §C/§D 4 helper 细粒度方案** (recoverer-types / recovery-cwd / recovery-placeholder / codex-jsonl-exists) 留作 体积治理 follow-up,不阻塞 R5 合并

## LOC 总览

| 文件 | R3 → R4 | 差额 |
|---|---|---|
| codex sdk-bridge/index.ts | 1010 → **874** | -136 (-13.5%) |
| codex sdk-bridge/recoverer.ts | 617 → **597** | -20 (-3.2%) |
| claude sdk-bridge/index.ts | 806 → **840** | +34 (jsdoc 保护清单,zero behavior change) |
| claude sdk-bridge/recoverer.ts | 670 → 670 | 0 (C follow-up) |
| 5 新 helper 共计 | - | +566 (含 jsdoc 注释 ~50%) |
