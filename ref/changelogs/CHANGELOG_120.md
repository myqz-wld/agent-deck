# CHANGELOG_120 — adapter-architecture-design RFC × R1+R1.5 异构对抗 × 三章 ✅ accepted（plan adapter-architecture-design-20260515）

## 概要

REVIEW_40 follow-up P2 留 architectural plan 的 3 个 design question（P4 BaseAdapter / 跨 adapter sandbox 继承 / scheduler 命名）design RFC 收口。本 plan **仅产 design 决策不动 src/ 代码**，输出 = `docs/adapter-architecture-rfc-20260515.md` + 三章实施 follow-up 决策记录（不单独建 stub plan 文件，未来真触发时新建 implementation plan 引用本 RFC chapter）。

R1 双外部 CLI（reviewer-claude Opus 4.7 + reviewer-codex gpt-5.5 xhigh）异构对抗 RFC 初稿后三章三态裁决：Chapter 1 ❓ revise / Chapter 2 ❌ reject as written / Chapter 3 ❓ revise。R1.5 反驳轮把 Chapter 2 codex HIGH「Option D 默认放宽」反驳成立 → lead 重写 Option D 为 string enum。R2 修订三章 +322/-98 行后用户三章全 ✅ accept。

## 异构对抗成果（双 reviewer teammate 同对跨轮复用）

| 轮次 | reviewer 模式 | 主要发现 |
|---|---|---|
| R1 | Bash 起外部 CLI（双方独立 oneshot） | 9 finding（3 HIGH + 6 MED）：Chapter 1 D 升 D2（typed registry binding 双方独立提）/ Chapter 2 lossy 详细清单 + D 重写 + E 改 warnings 字段 + 加 Option F+G / Chapter 3 Scheduler 范围定义 + 双类周期 settings |
| R1.5 | Bash 反驳轮（lead 倾向 ✅ 必修） | F1 部分反驳（lead 程度高估 → severity HIGH→MED 但章节加边界方向对）+ F3 反驳成立（事实错误：reviewer-* 引用是应用 CLAUDE.md 非 user CLAUDE.md，同 system prompt 内 cross-reference 不构成 hard dependency） |
| R2 修订 | lead 自主按裁决表 | RFC R2 修订三章 +322/-98 行（commit 7e4bec6 → rebase 后 041d300） |

## 三章 sign-off（commit 92a4752 → rebase 后 ebb4b2c）

| Chapter | 主题 | sign-off | 实施 plan 触发条件 |
|---|---|---|---|
| 1 | P4 BaseAdapter / CreateSessionOptions 拆判别联合 + typed registry binding（**Option D2**） | ✅ accepted | parity-plan Phase A+B 收口 + 协调 extraAllowWrite 字段位置 |
| 2 | 跨 adapter sandbox 继承（**Option D 重写 string enum** `inherit_sandbox: 'restrictions-only'` + escape hatch `allow_unrestricted_mapping` + **Option E 重写 warnings: string[] 字段** + emit message 双发） | ✅ accepted | 用户实际报跨 adapter spawn sandbox 配错 bug 或主动要求实施 |
| 3 | Scheduler 命名 convention + **范围定义**（Scheduler = lifecycle 状态机；Summarizer / UniversalMessageWatcher 不在范围）+ **双类周期 settings 约定**（lifecycle 热更新阈值 / 周期任务统一 setIntervalMs） | ✅ accepted | 不需独立 plan，下次加新 scheduler 引用本 RFC Chapter 3 |

## R1.5 反驳轮关键反转

**reviewer-claude R1 finding F3 事实错误**：当时说 "reviewer-claude.md:36-37 / reviewer-codex.md:42 仍引用 user CLAUDE.md 节号" — R1.5 reviewer-codex grep 实证 9 处引用是**应用 CLAUDE.md** + 仅 SKILL.md:46+107 两处真引用 user CLAUDE.md 且都是 supplementary citation（关键操作已 inline）。lead 在 R1 也曾把 "supplementary citation" 与 "hard dependency" 一刀切错，R1.5 双方独立反驳让 lead 修正过严判断。

## Phase 4 follow-up 决策记录（不建独立 stub plan 文件）

未来真触发 Chapter 1 / 2 实施时，新建 implementation plan 在 frontmatter 引用 `parent_rfc_id: adapter-architecture-rfc-20260515` + `parent_rfc_chapter: <N>`，按 RFC §"实施 follow-up 决策记录" 节决策摘要直接动手。Chapter 1 plan id 建议 `p4-baseadapter-d2-implement-<YYYYMMDD>`；Chapter 2 plan id 建议 `cross-adapter-sandbox-inherit-<YYYYMMDD>`。

## 工作量 / 影响

- 4 commit / +389/-111 行（rebase 后 5a27334 / 041d300 / ebb4b2c + 本 CHANGELOG）
- 全部 docs 改动，**0 行 src/ 代码 / 0 行 test**
- typecheck 应零变化（不实施代码）
- 无 vitest 跑（无代码改动）
- 无 lint / build 跑（无代码改动）

## 异构对抗机制 ROI

- R1 9 条 finding 中 **5 处双方独立提出**（异构强冗余直接验证）+ 3 处单方 + lead 自验成立 + 1 处 *未验证* lead 现场验证
- R1.5 反驳轮**纠正 lead R1 阶段同款一刀切错**（"supplementary citation = hard dependency"），证明反驳机制对单边判断的纠偏价值
- 全程 lead 自主修订（reviewer 反馈采纳是 lead 三态裁决判断）+ 用户每章 sign-off 关键 architectural 决策（Option D2 / Option D 重写 / 范围定义）

详 [`plans/adapter-architecture-design-20260515.md`](../plans/adapter-architecture-design-20260515.md)（含 `adapter-architecture-rfc-20260515` 决策记录）。
