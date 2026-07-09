# CHANGELOG_159

CHANGELOG_157 R2 reviewer-codex MED-2 follow-up — codex frontmatter `model` 真生效 regression test:

## 概要

CHANGELOG_157 让 codex SDK ThreadOptions.model 真生效 (一行 dead-letter fix),但 R2 reviewer-codex MED-2 指出缺 regression test。本 changelog 加 6 个 unit test 验证 `runCodexOneshot` 的 ThreadOptions.model 透传 + 边界 case + 其他 ThreadOptions 字段不受影响。

## 变更内容

### 新建 `src/main/adapters/codex-cli/__tests__/codex-model-passthrough.test.ts`

Mock `getCodexInstance` 返 fake Codex (startThread 捕获 ThreadOptions 参数),6 个 unit test:

| # | case | 预期 |
|---|---|---|
| 1 | `opts.model = 'gpt-5.5-mini'` | ThreadOptions.model === 'gpt-5.5-mini' |
| 2 | `opts.model = undefined` | ThreadOptions 无 model 字段 (fallback `~/.codex/config.toml`) |
| 3 | `opts.model = ''` (空字符串) | ThreadOptions 无 model 字段 (trim+length>0 守门) |
| 4 | `opts.model = '   '` (全空格) | ThreadOptions 无 model 字段 (trim 后视为空) |
| 5 | `opts.model = '  gpt-5.5  '` (前后空格) | ThreadOptions.model === 'gpt-5.5' (干净 trim 后值) |
| 6 | 完整 ThreadOptions 字段 (sandboxMode / approvalPolicy / skipGitRepoCheck / modelReasoningEffort) | 不受 model spread 影响,全部 expected 值 |

Mock 策略与现有 `sdk-bridge.early-err-cleanup.test.ts` 同款 (fake Codex 类 + 捕获 startThread opts)。

## Follow-up backlog 收口

CHANGELOG_157 + CHANGELOG_158 + CHANGELOG_159 三 commit 共同收口 deep review R2/R3 残留 follow-up backlog 5 项:
- ✅ LOW-1 SummarySection.tsx UI 接 codexSummaryModel + codexHandOffModel (CHANGELOG_158)
- ✅ LOW-R2-1 settings UI trim 校验 (ModelInput.commit 早已 .trim 自动消除,CHANGELOG_158 ack)
- ✅ MED-2 codex model regression test (本 changelog)
- ✅ 透明配置从设置面板排除 (CHANGELOG_158)
- ✅ 加快捷键说明 section (CHANGELOG_158 新建 KeyboardShortcutsSection)

## 验证

- `pnpm exec vitest run src/main/adapters/codex-cli/__tests__/codex-model-passthrough.test.ts` — 6 passed (271ms)
- `pnpm typecheck` GREEN
