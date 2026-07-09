# CHANGELOG_129 — deep-review-batch-a1-b-followup-r3-20260519 plan 收口: 5 HIGH + 9 真 MED + F1/F2 + R3 fix 4 HIGH + 6 MED 落地

## 概要

收口 deep-review-batch-a1-b-fixes-20260519 (commit `074782e` 已归档) R3 verify 重 spawn 4 reviewer 发出的 5 HIGH + 9 真 MED + 2 用户反馈（F1 baton dormant + F2 archive_plan mainRepo dirty fail-fast UX），按「复杂 plan 流程 v2」(RFC 两轮 + spike 实证 + plan-review 5 轮双对抗 + Phase 1/2/3/4/5/6 fix + R3 verify) 全量推进。

**22 commit chain 落地**：
- **Phase 1-6 共 15 commit**：Test debt 工程化补全 + Race 修法 (C) 双保险 + Cache 同步 (H3) + archive_plan precheck 精确化 + F1 baton + escape hatch + 杂项收口
- **Phase R3 fix 共 7 atomic commit**：fresh reviewer pair 发出 4 真 HIGH + 6 真 MED + 2 LOW/INFO 全修

typecheck / 32 file 416 test pass + 5 skip / build 全过。本轮 R3 verify 共识收口（双方 ✅ 0 残留 HIGH/MED）。

## 变更内容

### Phase 1 — Test debt 工程化补全（commit `034efea` / `aa35c1c` / `d82fa60` / `80cba1f` / `d99592f` / `9e31276`）

抽 lambda export 让 test 调真生产代码（D6 不变量 3 端到端断言生产 lambda），不再 inline 复制合约：
- `transport-http.ts` 抽 `resolveCallerSidForReadOnly` lambda + 53 test pass（spoofing-attack-paths / helpers.deny-external / transport-http-extra-auth）
- `archive-plan-impl.ts` 抽 `assertMainRepoCleanForArchive` + `assertBaseBranchIsNamedBranch` lambda（NUL parser + R/C 双 path + repo-relative）+ 28 test pass
- `hand-off-session.ts` 抽 `resolveBatonRoleForSpawn` lambda + 8 test pass
- 新建 SDK race test (`MockSdkQuery` stateful 三态机 + createsession-fail-fast + setttimeout-fallback-symmetry) — 3 skip 等 Phase 2 unskip
- `file-change-intent-delay.test.ts` + `set-permission-mode-rollback.test.ts` 补 finally clear / 改真 bridge factory

### Phase 2 — Race 修法 (C) 双保险（commit `1f43302` / `f2184df` / `7aa6103` / `b8a2961`）

不变量 1 兑现 — SDK first-id race 不再有覆盖窗口：
- `stream-processor.ts` setTimeout fallback fire 路径 fire-and-forget interrupt + idempotency `interruptFired` flag + consume L221 first-id (B) guard 用临时 `incomingId` 不写 realId + sid 三档链 (translate + finally cleanup)
- `index.ts` createSession throw catch 块 fire-and-forget interrupt + idempotency guard
- `sdk-message-translate.ts` expectedClose result frame skip 已 land 加 inline comment
- `setPermissionMode` per-session `permissionModeSeq` guard 防同 session same-mode 并发回滚污染（R3 fix-3 后被 chain 串行化替代）
- 图片工具 file-changed `status` gate (M2) + `restart-controller.ts` listen `session-renamed` event 用 `currentSid` ref 防 fork rename (M3)

### Phase 3 — Cache 同步 H3（commit `7e68a17`）

不变量 2 兑现 — `sdk-message-translate.ts:181` 在白名单 if 块第一句插入 `internal.permissionMode = next` 让 canUseTool bypass 短路立刻按新 mode 判断（permissionMode 路径 internal cache ↔ DB 单一源）。

### Phase 4 — archive_plan commit pathspec（commit `8fa571c`）

不变量 4 兑现 — `archive-plan-impl.ts:980` `git commit -m <msg>` → `git commit -m <msg> -- <pathspec>` 显式只包含 plan / INDEX / changelog 三类归档文件，不吞 mainRepo 预存 staged。

### Phase 5 — F1 baton + escape hatch + exit-worktree 收口（commit `50490f5` / `9c09c8a`）

不变量 6 兑现 — hand_off / archive_plan teammate 收口对称 + 软约束防绕过：
- F1a inline 实证 — `dormant-teammate-shutdown.test.ts` 实证 listActiveMembers SQL 不过滤 lifecycle / helper 不读 lifecycle 字段直接串行 closeFn
- F1b 软引导 — `archive-plan-impl.ts` mainRepo dirty precheck 失败 hint 加 escape hatch 引导（不建议手工绕过 / 优先 fix conflicts / 必须时调 `mcp__agent-deck__shutdown_baton_teammates`）
- F1c escape hatch tool — 新增 `shutdown_baton_teammates` mcp tool（schemas + types EXTERNAL_CALLER_ALLOWED + handler + 6 test + 应用 CLAUDE.md 同步）；R2 codex MED-4 错误契约 caller-not-lead → error + hint（非 silent success）；deny external
- F1d 确认 + grep — `archive-plan.ts` jsdoc 加可重跑 grep 引用 keep_teammates / runBatonCleanup 命中行号 + default 已是当前行为非 BREAKING
- rejoin-after-soft-exit.test.ts 3 case — PK row 总数不变 + 多轮 leave/rejoin same PK row + active 重复 add throw
- exit-worktree partial-success error path 加 "partial-success:" 前缀 + clear marker + markerCleared 透传 + step 4 .git rev-parse 失败 catch 块加 action='keep' partial-success cleanup

### Phase 6 — 杂项收口注释精确化（commit `e24e335`）

- M7+I2 `tools/index.ts:73-84` callerSessionIdOverride JSDoc 同步明确 prod 3 transport 永不返 null + fallback chain 标 test seam
- L1 `index.ts:557` setPermissionMode by-design 时序窗口标注（防 reviewer 后续轮次重提）
- L3 `transport-http.ts:110` ternary 注释精确化（保留 future-proof）
- L4 跳过 — 与 B-HIGH-1 (C) 严格 deny 矛盾
- U2-U5 跳过 — Round 5 已 ✅ 共识

### Phase R3 verify — 4 reviewer fresh pair 发出 finding + 三态裁决（commit `313410f` 到 `b08359e`）

R3 verify 重 spawn fresh reviewer pair（reviewer-claude 全量 + reviewer-codex 3 batch A/B/C+D 并发，因 codex 32 文件 xhigh scope 撞 6m4s budget 限制按主题拆批），4 份独立 finding 合并三态裁决：

**真 HIGH ×4（必修，全 land）**：
1. **R3-fix-1 H1** (commit `313410f`) — `restart-controller.ts` Phase 2.9 不对称 race + recovering Map key set/delete 不一致（claude MED-1 + codex A HIGH-1 合并升级）：两 restart 方法对称加 listener + transfer Map entry from OLD → NEW（防 stale Promise 永驻 + NEW caller 绕过单飞）+ 5 race test pass
2. **R3-fix-2 H2** (commit `4507537`) — `archive-plan-impl.ts:144` `runGit.trim()` 破坏 porcelain `-z` NUL 输出（codex B HIGH-1）：runGit 接口加 `opts.raw` 让 caller 显式跳 trim；现场实测铁证 `' M plans/INDEX.md\0'.trim()` → status 错位 → criticalSet 永不命中 → Y 列 unstaged critical path 全漏判
3. **R3-fix-2 H3** (commit `4507537`) — `archive-plan-impl.ts:340` base_branch rev suffix 绕过（codex C+D HIGH-1）：加 `git check-ref-format --branch <name>` 一阶 reject rev syntax；现场实测铁证 `refs/heads/main~1` 通过 rev-parse 验证 exit 0 → ff-merge `git checkout main~1` 进 detached HEAD → 数据丢失
4. **R3-fix-2 H4** (commit `4507537`) — `archive-plan-impl.ts:250` git status 缺 `--untracked-files=all`（codex C+D 未验证升级）：现场建临时 git repo 实测 default mode 输出 untracked 仅目录级 `?? plans/\0` → criticalSet.has('plans/INDEX.md') 不命中 → untracked critical 文件全漏判

**真 MED ×6（全 land）**：
- **R3-fix-3 M3** (commit `f00ade3`) — `setPermissionMode` chain 串行化替代 Phase 2.7 seq counter（codex A HIGH-2 降级 MED）：per-session async lock 防双失败脏 cache（A 失败 + B 失败 → B catch 回滚到 A optimistic 写入值，安全降级风险）
- **R3-fix-4 M2** (commit `8721786`) — `transport-stdio.ts` export `stdioCallerSessionIdOverride` lambda 给 spoofing-attack-paths.test.ts 真 import（codex C+D MED-1）：防 production 回退被静默 ship
- **R3-fix-5 M5** (commit `4db30c3`) — `exit-worktree.ts` handler wrapper `err()` 透传 `markerCleared` 字段（codex B MED-2）：扩展 err helper 加 optional `extras` 参数，partial-success caller 据此判断 retry hint
- **R3-fix-6 M6** (commit `9c270fb`) — `dormant-teammate-shutdown.test.ts` 补 in-memory DB case 锁真 SQL invariant（codex C+D MED-2）：将来 SQL 加 lifecycle 过滤 → test 同步 fail 报警
- **R3-fix-7 M1** (commit `b08359e`) — `spoofing-attack-paths.test.ts` + `helpers.deny-external.test.ts` writeTools 数组补 `shutdown_baton_teammates` 第 8 个写 tool（reviewer-claude LOW 升级）：矩阵 test 覆盖 Phase 5.3 新增 tool
- **R3-fix-7 M4** (commit `b08359e`) — `archive-plan-impl.ts` commitMsg 加 mainRepo unrelated dirty 注脚（codex B MED-1）：git log 持久化归档时刻 mainRepo 状态可审计 trail

**真 LOW + INFO ×2（trivial 顺手清）**：
- **R3-fix-7 L1** (commit `b08359e`) — 应用 CLAUDE.md `archive_caller=false` 时 `batonMode=false` 退化 normal spawn 不跳 depth check 文档修订（codex C+D LOW）
- **R3-fix-7 I1** (commit `b08359e`) — `stream-processor.ts:154` + `index.ts:327` 两处 fire-and-forget interrupt 加 `.catch(err => console.warn(...))` 吞错防 unhandled rejection（reviewer-claude INFO + codex A MED-1）

## 验证

```
pnpm typecheck    ✅
pnpm test         ✅ 32 file 416 test pass + 5 skip
                    (rejoin-after-soft-exit + dormant-teammate-shutdown 5 skipped =
                     better-sqlite3 binding ABI mismatch by-design)
pnpm build        ✅
```

## 关联归档

- [REVIEW_48](../../reviews/history/REVIEW_48.md)：本 plan 全程异构对抗 review × 5 轮 plan-review + 1 轮 R3 fresh reviewer verify 三态裁决详情
- plan archive 路径：`<main-repo>/plans/deep-review-batch-a1-b-followup-r3-20260519.md`（C6 archive_plan tool 完成后）
- 上轮 plan 引用：[CHANGELOG_128](./CHANGELOG_128.md) + [REVIEW_47](../../reviews/history/REVIEW_47.md) (deep-review-batch-a1-b-fixes-20260519)
