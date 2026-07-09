# CHANGELOG_204

## HeaderTokenRates 居中布局 + tok/s 恒为 0 排查启动

### 改动

`src/renderer/components/HeaderTokenRates.tsx:57` —— 外层 `flex` 容器加 `justify-center`，让多 bucket token rate 行从「靠左」改为「居中」展示。1 行 CSS 改动，**不影响** tok/s 数值计算（`tps = rateByBucket.get(row.bucketKey) ?? 0` 逻辑未动）。

### tok/s 恒为 0 排查（启动 — 未完结）

用户报「应用栏 tok/s 恒定为 0」。本 CHANGELOG 不掩盖问题：layout diff 与该现象**无关**（未动 rate 计算），但本批 commit 之后即开始排查。

**已知线索**：
- `rateByBucket.get(row.bucketKey) ?? 0` 是兜底 —— 即便 store 没数据也不报错，永远显示 0
- 真正决定 rate 是否非零的是 `top` 数组 + `rateByBucket` Map 的来源（store / IPC push 频率 / 滑动窗口算法）
- 改动前就有还是改动后才有 → 用户需在 dev 实例确认时间线

**排查路径（lead 跟进）**：
1. 在 main 进程 console 看 `token-rate-store` 是否有 push 事件（store 名以实际为准 — grep `rateByBucket` 找上游）
2. 确认 sliding window 是否因长时间不活跃被清空
3. 跑一个有产出的 session 验证是否真的恒为 0（vs 间歇性 0）

排查结论 + 修法会进 CHANGELOG_205 或作为本批的 fix 块追加。
