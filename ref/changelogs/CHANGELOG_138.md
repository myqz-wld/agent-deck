# CHANGELOG_138 — 图片附件「随便粘一张图就报超 30MB」误报修复

## 概要

`useImageAttachments` 内 `add()` 流程下 React 18 setState updater 时序 race —— `let admittedThisRound = false; setAttachments(prev => {...; admittedThisRound = true})` 后立即 `if (admittedThisRound)` 检查时,React 18 把 updater enqueue 到 work loop 等当前 callback 结束才 flush,**flag 永远是 false** → 走 else 分支误报「总附件超过 30MB 上限」。用户每次粘任意一张图都会撞这条误报,但实际 entry 又被 updater 写进了 attachments state(只有 error toast 误报,行为不影响附图发送)。

## 修法

`src/renderer/hooks/useImageAttachments.ts`:

- 加 `attachmentsRef = useRef<UploadedAttachmentEntry[]>([])` 同步映射 attachments state(useEffect 兜底 + add/remove/clear 内手动同步双轨)。
- `add()` 内用 `attachmentsRef.current` 在 `setAttachments` **之前**预算 `currentTotal`,通过则 ref + state 一起手动更新,updater 退化为简单 `prev => [...prev, entry]`(不再判断 limit)。
- `remove() / clear()` 同步更新 ref,保持 ref 与 state 一致(下一次 `add()` 用 ref 算 currentTotal 取最新值)。
- 弃用 `let admittedThisRound = false` 闭包 flag。

## 不变量

- ref 与 state 一致性靠两条:① `add/remove/clear` 在调 setAttachments 同时手动 set ref ② `useEffect(() => { attachmentsRef.current = attachments }, [attachments])` 兜底防遗漏(commit phase 跑)。
- REVIEW_35 R2 HIGH-D-R2-1 「ref 孤儿」race 仍闭合:本修法把 ref.set 移到「ref 同步路径(必通过)」之后,`setAttachments(prev => [...prev, entry])` 必成功不再 reject → ref 不会孤儿。
- 并发 add() 多次重入仍可能 ref 旧值 race(两次 add 同时看到 ref 旧 currentTotal),但即使越界 30MB 也被 IPC 层 `MAX_TOTAL_ATTACHMENTS_BYTES` 30MB 兜底拒,不影响安全。

## 复现 + 实证

`/tmp/admit-flag-race.mjs` Node sim 模拟 React 18 setState updater enqueue 行为(microtask flush) —— 单图 5MB 应能 admit,但 sync flag 检查 100% 误报 reject。修法通过后用户实测:粘 1 张普通截图 → 不再触发「总附件超过 30MB 上限」错误。

## verify

- `pnpm typecheck` ✓ 0 errors
- `pnpm exec vitest run` ✓ 814 passed | 83 skipped(原 3 fail 是 `src/main/task-manager/__tests__/tools.crud.test.ts` pre-existing fail,与本改动无关 — git stash 验证)

## 触发

用户反馈:「创建会话时,随便粘贴一张图还是报超过 30MB」。REVIEW_35 R2 修过 ref 孤儿(把 fullBase64Ref.set 移进 updater),但 admittedThisRound flag race 没修 → error 误报这条仍在。本 changelog 收口此残留 bug。
