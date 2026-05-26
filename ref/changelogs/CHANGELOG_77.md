# CHANGELOG_77: SessionList 按 spawnedBy 树形折叠 + lead/teammate badge

## 概要

实时面板 SessionList 内 active / dormant 各组按 `session.spawnedBy` 关系做树形分组：lead 在前、teammate 缩进在 owner 下方（左侧细蓝边 indicator）。SessionCard 加 `teamRole?: 'lead' | 'teammate'` prop：lead 容器加蓝色边框、teammate 加 `↳ teammate` 浅蓝小 chip。孤儿 teammate（owner 不在本 group 可见列表 → 已 closed / 已归档 / 跨 active vs dormant 边界）按 D8 决策不绑死，仍平铺为 root（不强制保留 lead 上下文）。点击行为完全沿用现有 SessionCard onSelect → store.selectSession，进入 detail / 用 ComposerSdk 发消息流程不变。

## 变更内容

### renderer (`src/renderer/components/SessionList.tsx`)

- 新增 `renderTreeGroup(sessions, selectedId, onSelect)` helper：按 `spawnedBy` 分组到 `childrenByOwner: Map<ownerSid, SessionRecord[]>` 与 `roots[]`，渲染时 root 后立即跟一个 wrapper div 装 children（`ml-3 border-l border-blue-400/20 pl-2.5` 缩进）
- root 若 `childrenByOwner.get(root.id).length > 0` → `teamRole='lead'` 透传给 SessionCard；children 都 `teamRole='teammate'`
- 跨 group 不关联（active group 内的 lead 与 dormant group 内的 teammate 不串）—— 简化数据结构 + 避免 cross-group 跳跃
- 老的 active / dormant 两 section 渲染壳 + selectLiveSessions 过滤逻辑保持不变

### renderer (`src/renderer/components/SessionCard.tsx`)

- Props 加可选 `teamRole?: 'lead' | 'teammate'`
- 容器边框：`teamRole === 'lead' && !selected` 时切到 `border-blue-400/40`（与 selected 的 `border-white/30` 互斥；selected 视觉优先）
- 元数据行加两个新 chip（接在已有 🛡 teamName chip 后）：
  - lead → `👑 lead` 浅蓝 bg + 蓝色文字
  - teammate → `↳ teammate` 更淡蓝 bg + 略浅文字
- 与已有 🛡 紫色 teamName chip 颜色风格区分（紫=team 名字归属，蓝=team 内角色）

## 备注

- 关联 plan：[`.claude/plans/deep-review-flow-fix-20260512.md`](../.claude/plans/deep-review-flow-fix-20260512.md) Phase C
- D8 决策：孤儿 teammate（owner 已 closed / 归档 / 跨 group 边界）平铺为 root + 不加 badge（不绑死 owner，避免「owner 已不在但 teammate 永远缩进显示找不到 lead」的视觉不清）
- N+1 性能：`renderTreeGroup` 内一次 O(N) 扫描建 Map，渲染时 O(roots) 查 children；list 默认显示 ≤ 50 sessions，性能可忽略
- typecheck + build 全过；本 phase 无 unit test（renderer 视觉逻辑，主要靠 dev 实测验证；后续如要加可走 React Testing Library 测 SessionList 树形结构）
- 改 renderer → HMR 自动推送，无需重启 dev（项目 CLAUDE.md 「验证流程」节）
- 上游依赖：依赖 plan §B.2 的「lead 加 team membership」机制 —— 实际上 spawn_session handler 第 336-348 行**已经实现**（plan v1 误判为 D3 子项，CHANGELOG_76 已澄清）；本 phase 渲染时直接消费 `session.spawnedBy` 字段不依赖 team membership
