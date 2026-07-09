# CHANGELOG_139 — codex spawn 主路径 applicationSid 漏切修复(spawn-link 静默漏写收口)

## 概要

`reverse-rename-sid-stability-20260520` plan §A.4-pre S3 在 codex 端实施时漏写 `internal.applicationSid = ev.thread_id;` 这行 assignment(claude 端 stream-processor.ts:328 已落,codex 端 thread-loop.ts case 1 注释口头说"切到 first thread_id"但代码没切)。漏切让 `internal.applicationSid` 永远是 ctor 时的 tempKey,`bridge.createSession` line 689 `return { sessionId: internal.applicationSid }` 返 tempKey 不是 realId,spawn handler `setSpawnLink(tempKey, caller, depth)` UPDATE 撞 sessions 表无 row(rename.ts:57 fromRow 不存在 noop)→ changes=0 静默失败 → spawned_by 永远 NULL → SessionList 把 codex teammate 在「活跃」section 顶级平铺,**没显示成 lead 的 child**(违反 SessionList Phase C 树形分组语义)。

bash 单轮异构对抗 review(reviewer-claude Opus 4.7 + reviewer-codex gpt-5.5)双方独立同款铁证 HIGH-1,现场 SQL 6/6 命中根因预测,split-brain 双 row(realId 行 + tempKey 行)预测被 SQL 实测验证。

详见 [`reviews/REVIEW_50.md`](../../reviews/history/REVIEW_50.md)。

## 修法

### `src/main/adapters/codex-cli/sdk-bridge/thread-loop.ts` HIGH-1 修法(加 1 行 assignment)

case 1 spawn 主路径 first `thread.started` 到达时,加 `internal.applicationSid = ev.thread_id;`(对称 claude 端 stream-processor.ts:328):

```ts
// case 1: 新建路径 — spawn 主路径 first thread.started 到达
internal.applicationSid = ev.thread_id;  // ← CHANGELOG_139 加这行
internal.threadId = ev.thread_id;
if (firstIdCb) {
  firstIdCb(ev.thread_id);
  ...
}
```

fix 后链路:
- `bridge.createSession` 返 `{sessionId: realId}`(不再是 tempKey)
- spawn handler `setSpawnLink(realId, caller, depth)` 命中 realId row(firstIdCb emit session-start 已建)→ spawned_by 正确写入
- runTurnLoop translate-driven emit 用 `internal.applicationSid = realId` → 全部 events 写到 realId 行,**split-brain 消失**(不再产生 tempKey 孤儿行)

### `src/main/store/session-repo/spawn-chain.ts` MED 配套(setSpawnLink 加 changes=0 warn)

防 future regression 静默淹没:

```ts
const info = ...prepare(...).run(spawnedBy, depth, id);
if (info.changes === 0) {
  console.warn(`[setSpawnLink] UPDATE 0 rows for id=${id} ...`);
}
```

## 不变量

- codex 端与 claude 端 spawn 主路径 first thread.started 处理对称(双方都在 InternalSession ctor 后 first realId 到达时切 `applicationSid` 到 realId 后冻结)
- 修法**不动** plan reverse-rename §A.4-pre 设计本身(D1-D8 8 轮 deep-review 收口),仅补 codex 端 S3 实施漏的 1 行 assignment
- setSpawnLink 撞 changes=0 现 console.warn,**不**改 throw / 不变 return type(避免 caller 回滚兼容性破坏);warn 当 future regression early signal

## 已知 follow-up

- **stale 双 row 现存 DB 不动**:用户当前 DB 里 reviewer-codex 残留 `2af17d51-...`(UUIDv4 tempKey 行 cwd='')+ `019e4961-...`(UUIDv7 realId 行 cwd 正常)双条,fix 后**新起的** codex teammate 不会再产生这种 split-brain;**旧 stale row 不自动清**,用户可手动归档(重启不影响新 fix 行为)
- LOW-1 firstIdCb emit session-start hard-code `sessionId: realId` 与 runTurnLoop emit 用 `internal.applicationSid` 隐式契约(reviewer-claude *未验证*):HIGH-1 fix 后两者自然同源,可后续加注释或统一
- LOW-2 plan §A.4-pre §不变量 1 要求 ensure() 新建外部 CLI / session-start record 默认 `cli_session_id=sessionId`,实施漏(reviewer-codex MED-3):不直接撞本 bug 但破坏 ingest 反查锚点,留下次 plan closure 一并补
- LOW-3 测试盲区(reviewer-codex LOW-1):`sdk-bridge.consume-fork.test.ts` case 1 没断言 `internal.applicationSid` 切 tempKey → realId,本次 fix 没补单测;后续可加 `expect(internal.applicationSid).toBe('NEW_ID')` 锁不变量

## verify

- `pnpm typecheck` ✓ 0 errors
- `pnpm exec vitest run src/main/adapters/codex-cli src/main/store/session-repo` ✓ 82 pass / 7 skip / 0 fail
- 双 reviewer 独立同款铁证 HIGH-1(reviewer-claude Opus 4.7 / reviewer-codex gpt-5.5,xhigh reasoning,现场 SQL 6/6 命中)
- **用户实测**:重启 dev / 重装 .app → lead spawn 新的 codex teammate → SessionList 应嵌套显示在 lead 下面(↳ teammate badge,与 reviewer-claude 同款)

## 触发

用户反馈:「spawn codex cli session 显示有问题,在「活跃」section 顶级平铺,没作为 reviewer-claude 同款 child 嵌到 lead 下面」。bash 单轮异构对抗 review 双方独立 ✅ HIGH 铁证(详 [`reviews/REVIEW_50.md`](../../reviews/history/REVIEW_50.md))。
