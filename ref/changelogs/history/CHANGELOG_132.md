# CHANGELOG_132 — Plan `remove-aider-generic-pty-adapters-20260520` Follow-up F2: 防递归阈值默认值上调

## 概要

实施 `plans/remove-aider-generic-pty-adapters-20260520.md` §Follow-up F2 — 把 `mcpMaxFanOutPerParent` 默认值 5 → 10 + `mcpSpawnRatePerMinute` 默认值 10 → 20 在所有路径上对齐。`shared/types/settings.ts` defaults / jsdoc 描述都已是新值(CHANGELOG_125 P5 plan 已升),但 `spawn-guards.ts` runtime fallback 老值 + user persist store 老值未 migrate。

修法:
- `spawn-guards.ts:80-81` runtime fallback `?? 5` / `?? 10` → `?? 10` / `?? 20` 与 settings-defaults 对齐
- `settings-store.ts:51` 加一次性 migration(transparentWhenPinned 同模式):persisted 值正好等于老 default(5/10)→ 升级到新 default(10/20);user 显式选非 default 值(7/15 等)→ 保留

trade-off 接受:罕见 false positive — user 主动选与老 default 同值时被 migrate(覆盖 user 显式选择)。但 deep-review 多 batch 场景下老 default(5 fan-out + 10 rate)在 deep-review 同时多对 reviewer 编排 / plan 完成 hand-off 起 Phase 接力 / 用户瞬时多操作场景中频繁撞顶(CHANGELOG_125 P5 plan 已实测撞顶),migrate 实际是 friendly action 与 README 描述对齐 + 设置面板 jsdoc"默认 10/20"语义一致。

verify:
- typecheck GREEN
- `pnpm exec vitest run src/main/agent-deck-mcp/__tests__/spawn-guards.test.ts` 12/12 pass(testfile 显式 set settingsState 字段,fallback 不触发,无 regression)

## 详情

详 [`plans/remove-aider-generic-pty-adapters-20260520.md`](../../plans/history/remove-aider-generic-pty-adapters-20260520.md) §Follow-up F2 节。
