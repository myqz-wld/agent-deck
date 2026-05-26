# Conventions 索引

> **目录定位**：项目特定约定的累积载体，与 `ref/changelogs/` `ref/reviews/` `ref/plans/` 同级。
>
> **目的**：让项目 CLAUDE.md 保持**静态**（只放设计原则 + 流程性约定），动态累积的「反复出现过的设计决定」沉淀到本目录单独维护。
>
> **流程**：候选放 `tally.md`，count ≥ 3 走「决策对抗」三态裁决后升级 → 新建 `<X>-<topic>.md`（X 递增整数）+ 本 INDEX 加行 + tally 删该候选条。详 `~/.claude/CLAUDE.md` §反复反馈→升级约定 节。

## 升级后约定

> 每个 `.md` 单文件 = 一条已升级的项目特定约定。改动相关代码前 `ls ref/conventions/` + 浏览相关条目，避免推翻已有约定。

| 文件 | 主题（≤ 80 字） | 升级日期 | 关联 changelog | 关联 review |
|------|---------------|---------|--------------|------------|
| [01-reviewer-claude-oneshot-disallow-exitplanmode.md](01-reviewer-claude-oneshot-disallow-exitplanmode.md) | 决策对抗 reviewer-claude oneshot (claude -p) 必须 `--permission-mode default` + `--disallowedTools` 含 `ExitPlanMode`；plan mode 撞 -p 非交互拒绝路径吞 finding | 2026-05-25 | — | [REVIEW_52](../reviews/REVIEW_52.md) 首踩 + [REVIEW_54](../reviews/REVIEW_54.md) 再踩 |

## 候选状态

详 [tally.md](tally.md)（用户反馈候选 / Agent 踩坑候选两 section）。

## 历史「项目特定约定」节

项目 CLAUDE.md `§项目特定约定` 节为本目录建立**之前**的历史升级累积位置。新升级一律走本目录 `<X>-<topic>.md`，历史节按主题逐步迁移（CHANGELOG_79 后第一次涉及某历史约定时顺带挪过来；不专门起拆分轮）。
