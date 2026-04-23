# 项目约定候选（待观察）

> 此文件由 Claude Code 自动维护。**不要手工删条目**。
> 当某条 count ≥ 3 时，会被升级到 [CLAUDE.md](../CLAUDE.md) 「项目特定约定」节。

## 用法（给 Claude Code 的内部约定）

两类候选，**同一文件分 section**：

| 类型 | 触发条件 |
|---|---|
| **用户反馈** (`# 用户反馈候选`) | 用户给「纠正性 / 偏好性」反馈：「不要…」「应该…」「我已经说过…」「以后…」「记住…」「每次…」 |
| **Agent 踩坑** (`# Agent 踩坑候选`) | Coding Agent 在 review / 修 bug / 排查时**自己**发现踩了同类坑，或 review 报告里反复出现同类问题（典型：try/finally 漏 cleanup、TOCTOU、N+1 查询、async listener 不被 await） |

**操作流程**（每次接到符合条件的反馈 / 自己发现踩坑时）：

1. **判断范围**：
   - 用户反馈：必须是**项目内的工程偏好 / 设计取舍 / 工作流偏好**，一次性请求（"帮我改这个 bug"）不算
   - Agent 踩坑：必须是**模式化问题**（一类问题反复出现），不是单点 bug
2. **读本文件**，找语义相近的已有条目：
   - 找到 → `count` +1，更新 `last_at` 为今天日期
   - 没找到 → 新增条目（`count: 1`），写在对应 section
3. **count 达到 3** → 这是「约定升级」决策，按通用 CLAUDE.md「决策对抗」节走**双对抗三态裁决**：
   - 起两个独立异构 Agent，各自评审升级提案：措辞是否准确 / 边界是否清晰 / 与已有约定有无冲突 / 升级到哪一节最合适
   - 三态结果汇总后告诉用户「这条 [反馈/踩坑] 累计 3 次，对抗审视结论 ✅/❌/⚠️ 如下，要升级吗？」
   - 用户确认后才写入 [CLAUDE.md](../CLAUDE.md) 「项目特定约定」相应小节，从本文件删除该条目
4. **count < 3** → 静默更新本文件，不打扰用户

> 30 天未更新且 count < 3 → 下次扫描可主动清理。

---

# 用户反馈候选

按 `count` 倒序。

| ID | 描述 | count | first_at | last_at | 触发样例 |
|----|------|-------|----------|---------|----------|
| U1 | 用户在 UI 上做的选择默认要持久化（DB / 设置文件），不要只放内存让重启丢 | 1 | 2026-04-21 | 2026-04-21 | "权限的记忆也不能放内存吧" |
| U2 | 状态机的转换要跟实际可恢复能力对齐（有 resume 就别立刻 closed；内部 id 切换用 rename 而非 delete+new） | 2 | 2026-04-21 | 2026-04-21 | "能够恢复后，重启时，内部会话会被认为 closed 还合理吗" / "看会话详情老是被刷新到主界面" |

---

# Agent 踩坑候选

按 `count` 倒序。

| ID | 描述 | count | first_at | last_at | 触发样例 |
|----|------|-------|----------|---------|----------|
| P1 | 注册资源 / 标记后没在 try/finally 释放——失败路径漏清，状态卡 N 秒 / 误吞同类事件 | 1 | 2026-04-23 | 2026-04-23 | REVIEW_1 #2: sdk-bridge.ts releasePending 只在成功路径调，失败时 60s ttl 内同 cwd hook 被误吞 |
| P2 | 路径白名单 TOCTOU——校验用原始 path、读取走 realpath，symlink 改指向后越权 | 1 | 2026-04-23 | 2026-04-23 | REVIEW_1 #3: ipc.ts loadImageBlob symlink TOCTOU |
| P3 | 查表 / 校验时用全表扫 + 限 N 条 + JS 侧 .find/.filter，长会话或大数据后旧记录永久查不到 | 1 | 2026-04-23 | 2026-04-23 | REVIEW_1 #6: ImageRead 路径靠 listForSession 500 限制兜底 |
| P4 | Map / Set / cache 写入有分支条件，但 delete 只在某一分支末尾——其他分支线性泄漏 | 1 | 2026-04-23 | 2026-04-23 | REVIEW_1 #4: toolUseNames 只有图片工具分支 delete |
| P5 | Electron `before-quit` / 类似事件 listener 用 `async () => { await ... }`——回调返回的 Promise 不会被 await，清理只能碰运气跑完 | 1 | 2026-04-23 | 2026-04-23 | REVIEW_1 #7: index.ts before-quit |
| P6 | 全局 fuzzy 兜底匹配（"池子里只剩一个就一定是它"）——并发场景下会跨实体误命中 | 1 | 2026-04-23 | 2026-04-23 | REVIEW_1 #1: pendingSdkCwds size===1 模糊匹配误吞外部 CLI |
| P7 | catch 只 console.warn 吞错——上层 / UI 拿不到失败原因，用户看到「神秘 session-end」 | 1 | 2026-04-23 | 2026-04-23 | REVIEW_1 #5: SDK query loop catch |
| P8 | 依赖 npm/dev-only env（`process.env.npm_package_version` 之类）——打包后 undefined，硬编码默认值悄悄上线 | 1 | 2026-04-23 | 2026-04-23 | REVIEW_1 #8: AppGetVersion 永远显示 0.1.0 |

<!-- 历史升级范例（已升到 CLAUDE.md 的可在此处留 1-2 行注解，便于追溯）：
- P1 + P2 + P5 同主题已半升级到「资源清理 & TOCTOU 防线」小节作为预防（CHANGELOG_16），但表里仍保留 count=1 等下次再撞同主题时计数推进
-->
