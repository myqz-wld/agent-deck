---
review_id: 13
reviewed_at: 2026-04-29
expired: false
skipped_expired:
---

# REVIEW_13: approve-bypass 后弹「Agent 出错」mac 系统通知（REVIEW_11 Bug 1 范围补全）

## 触发场景

REVIEW_11 + REVIEW_12 落地后用户复测 ExitPlanMode 选「批准并切到完全免询问」（approve-bypass 冷切）：

- ✅ ede_diagnostic 红字 message 不再出现（REVIEW_11 Bug 1 修法生效）
- ✅ 孤儿「外」会话不再出现（REVIEW_12 Bug 5 origin tag 修法生效）
- ❌ macOS 系统通知中心仍弹**「Agent 出错」**横幅

## 方法

**未走双对抗**——本 bug 是 REVIEW_11 Bug 1 的**范围补全**，根因 / 修法都基于已确认的 P17「双通道防护」陷阱模式同源延续，符合 CLAUDE.md「trivial / 同源补丁」例外（一行 if return + 注释）。

诊断步骤：

1. grep `notify\|Notification` 找 mac 通知发出位置 → 锁定 `src/main/notify/event-router.ts:50` 的 `Agent 出错` 标题分支
2. 反推触发条件：`event.kind === 'finished' && payload.ok === false && payload.subtype !== 'interrupted'`
3. grep `emit('finished'` 找 sdk-bridge 唯一 emit 点 → `src/main/adapters/claude-code/sdk-bridge.ts:1672`（REVIEW_11 修过的 result frame 分支）
4. 对比 REVIEW_11 D'2 修法：只 gate 了 message emit（line 1668 `&& !internal.expectedClose`），**未 gate 同分支的 finished emit**（line 1672）→ approve-bypass 冷切下 expectedClose=true 时红字 skip ✅ 但 finished 还 emit，进 routeEventToNotification 推「Agent 出错」mac 系统通知 ❌
5. 确认 finished 下游消费者（manager activity 状态 / renderer UI）：approve-bypass 路径下 OLD record 后续会被 renameSdkSession 整体迁到 NEW_ID，OLD 的 finished 既不影响新 record 状态推进（NEW SDK 自己会发 finished），也不应该污染 dock / 系统通知 / UI 时间线 → **零副作用 skip 整个 result frame**

## 三态裁决结果

### ✅ 真问题（Bug 6）

| # | 严重度 | 文件:行号 | 问题 |
|---|---|---|---|
| 6.1 | HIGH | `src/main/adapters/claude-code/sdk-bridge.ts:1672` (result frame finished emit) | REVIEW_11 D'2 修法只 gate 红字 message emit（line 1668），漏 gate 同分支 finished emit（line 1672）。approve-bypass 冷切下 expectedClose=true 时红字 skip 但 finished 仍 emit → routeEventToNotification 看 `payload.ok===false` + `subtype !== 'interrupted'` → notifyUser({title:'Agent 出错',...}) → mac 系统通知中心弹「Agent 出错」横幅。**P17「双通道防护」陷阱再撞**：同分支三个通道（红字 message / finished UI / 系统通知），只 gate 一个 = 防护漏 2/3。 |

### ❌ 反驳

无。根因唯一明确。

### ⚠️ 部分

| 现场 | 角度 | 结论 |
|---|---|---|
| finished emit 完全 skip 是否会破坏下游 | manager.advanceState (line 503) 把 finished 推进到 'finished' 状态；renderer StatusBadge / SessionCard 据此显示 | approve-bypass 冷切路径下 OLD record 在 createSession resolve 后立即被 renameSdkSession 整体迁到 NEW_ID 名下，OLD record 不再独立存在；NEW SDK 子进程会自然发自己的 finished 推进新 record。OLD 的 finished 跳过 = 零副作用 |

## 修复（review 内直接落地，不新建 changelog）

### HIGH

1. **`src/main/adapters/claude-code/sdk-bridge.ts:1654-1672` (result frame 整体静默)** — 在 result frame 分支顶部加 `if (internal.expectedClose) return;`，三个通道（红字 message / finished UI / 系统通知）一起 skip。原 `&& !internal.expectedClose` gate 移除（已无意义，前置 return 提前退出）。

修法对比：

```diff
} else if (msg.type === 'result') {
  const r = msg as { ... };
+ if (internal.expectedClose) return;
- if ((r.is_error || (r.subtype && r.subtype !== 'success')) && !internal.expectedClose) {
+ if (r.is_error || (r.subtype && r.subtype !== 'success')) {
    emit('message', { text: `⚠ ${detail}`, error: true });
  }
  emit('finished', { ok: ..., subtype: ... });
}
```

## 关联 changelog

无（本 bug 是 REVIEW_11 Bug 1 修法的范围补全）。

## Agent 踩坑沉淀

`.claude/conventions-tally.md` 内 P17（「双通道防护」陷阱）count 1→2。下次同主题再撞即触发 count=3 升级到 CLAUDE.md「项目特定约定」节。
