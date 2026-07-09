# CHANGELOG_162

Hand-off default 改回 sonnet（推翻 CHANGELOG_161 的 haiku 化决策）+ SummarySection `ModelRow` 布局重排修挤压。

## 概要

User 一次性反馈两点：
1. **「hand off 默认 sonnet」**：CHANGELOG_161 把 hand-off fallback alias 从 `sonnet` 改成 `haiku` 与 summary 对齐，user 反馈推翻 — 4 节结构化简报对结构精度敏感，应单独保持 sonnet（summary 仍 haiku 不动）
2. **「模型框太小」**：SummarySection 截图显示 model input 只能显示 "ha"/"sor" 几个字符，几乎 0 宽

**根因**：CHANGELOG_161 follow-up 那次改加了 `min-w-0` / `shrink-0` 修了 reasoning select 被推出容器（前置 bug），但 SettingsDialog 容器只有 340px-padding=308px，单行硬塞 label(`w-32` 128px) + provider(~60px) + input(`flex-1`) + reasoning(`w-24` 96px) + 3 个 `gap-2`(24px) = 308px 把 input 压到 0 宽。

## 变更内容

### `src/main/session/summarizer/llm-runners.ts` fallback alias 改回 sonnet

`summariseSessionForHandOff()` L91-105 优先级链:
- 之前: `settings.handOffModel ＞ ANTHROPIC_DEFAULT_HAIKU_MODEL ＞ ANTHROPIC_MODEL ＞ 'haiku'`
- 现在: `settings.handOffModel ＞ ANTHROPIC_DEFAULT_SONNET_MODEL ＞ ANTHROPIC_MODEL ＞ 'sonnet'`

注释改写：明示「推翻 CHANGELOG_161 与 summary 对齐 haiku 决策；4 节结构化简报对结构精度 / 上下文压缩质量敏感，sonnet 显著更稳；summary 短 tag-line 容错高量大走 haiku 省成本」。

### `src/shared/types/settings.ts` `handOffModel` jsdoc 同步

优先级链 jsdoc 从 HAIKU → SONNET（claude provider 段）；尾段 "plan prancy-forging-penguin 改动 sonnet → haiku" 改写为 "default sonnet 与 summaryModel 默认 haiku 不同：简报结构精度敏感 sonnet 更稳"。

### `src/main/session/__tests__/hand-off.test.ts` 测试同步

- `happy path` 测试 L119-145：env 名 `ANTHROPIC_DEFAULT_HAIKU_MODEL` → `ANTHROPIC_DEFAULT_SONNET_MODEL`（setup/cleanup），expect 从 `'haiku'` → `'sonnet'`
- `uses ANTHROPIC_DEFAULT_HAIKU_MODEL env` test → 改名 `uses ANTHROPIC_DEFAULT_SONNET_MODEL env`，env 名同步，expect 从 `'claude-haiku-4-5-20251001'` → `'claude-sonnet-4-6'`
- `uses settings.handOffModel` test：env 名 SONNET（取代 HAIKU），mock 值 `claude-sonnet-4-6`

### `src/renderer/components/settings/sections/SummarySection.tsx` ModelRow 重排为 3 行

**之前**（单行塞 4 控件 + hint 第二行缩进 `pl-32`）：

```
[label w-32 128px][provider][model input flex-1][reasoning w-24 96px]
                              hint 缩进对齐 label
```

**现在**（3 行）：

```
label                                                    <- 第 1 行,去 w-32
[provider][model input flex-1     ][reasoning w-20]       <- 第 2 行,3 控件全宽
hint 全宽                                                  <- 第 3 行,去 pl-32 缩进
```

`flex-1` model input 现在拿到 ~140px(308 - 60 provider - 80 reasoning - 16 gap) 够显示 `claude-sonnet-4-6` / `claude-opus-4-7-thinking-max` 等长 model id。reasoning select 同步从 `w-24` 缩到 `w-20`（"medium"/"minimal" 字宽 80px 够）。

### hand-off row UI 文案更新

`SummarySection` 内 hand-off `ModelRow` 调用：
- `hint`：`default 同 haiku；想升 sonnet/opus 自己填 model id` → `default sonnet 保结构精度；想降 haiku 或升 opus/thinking-max 自己填 model id`
- `modelPlaceholder`：`haiku（沿用 env / alias）` → `sonnet（沿用 env / alias）`
- summary row 保持 `haiku` 文案不变

## 不影响

- `settings.handOffModel` default 仍为 `''`（空 = 沿用 fallback 链）— 老 user 已显式填 model id 的不受影响
- `settings.summaryModel` / fallback 链全部不动（haiku 仍是 summary 默认）
- `handOffProvider` / `handOffReasoning` 字段语义 / 默认值不动
- codex provider 路径(`summariseCodexSessionForHandOff`) 与 user 主仓库 `~/.codex/config.toml` fallback 链不动 — 本轮仅改 claude provider fallback 链
- SummarySection 其他控件(NumberInput / SummarizerErrorsDiagnostic) 不动

## 验证

- `pnpm typecheck` GREEN
- `pnpm exec vitest run src/main/session/__tests__/hand-off.test.ts` ✅ 6/6 pass
- UI 手测推迟到 `.app` 新版本发布后视觉验证：SummarySection 两个 ModelRow 现在 3 行布局，model input 占满第二行宽度，能完整显示 `claude-sonnet-4-6` 等长 model id；hand-off placeholder 显示 "sonnet（沿用 env / alias）"

## 已知踩坑

- 窄面板（≤ 400px）布局规则：**单行控件数 ≤ 2**。再多就被挤压成 0 宽（无 `min-w-[Npx]` 强制底也只是变 horizontal scroll 不够友好）。本轮把 label / hint 都拆成独立行，控件行只剩 3 个，input 拿到约 140px 充分宽度
- 默认 model 决策不一致是有意为之：summary 海量短输出走 haiku（成本敏感），hand-off 4 节结构化精度敏感走 sonnet — 不要再统一两边。CHANGELOG_161 把它们拉齐 haiku 是想简化心智模型，但牺牲了 hand-off 简报质量
