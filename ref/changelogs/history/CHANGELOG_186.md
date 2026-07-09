# CHANGELOG_186 — SDK 升级 0.3.144 → 0.3.158（应对 app 内 malformed 工具调用）

> plan `sdk-upgrade-thinking-fix-20260530`。app 内 SDK 会话工具调用外层 antml wrapper 损坏成乱码（典型 `court`），导致工具调用不被识别、不执行、整块当 assistant 纯文本输出给用户；前一个接力会话因此卡死 ~2.5h。升级 SDK 作为首选低风险尝试。**fix 待重启 app 后真实会话验证（spike 无法复现 → 无法在 spike 证明修复）。**

## 背景

模型生成的工具调用，**外层 `<function_calls>` / `<invoke>` 起始 token 被损坏**（`court`），内层 `<invoke name=...>` / `<parameter ...>` 结构完好 → CLI/SDK 解析器匹配不到合法 wrapper → 整块当 assistant text 输出 → translate 成 `kind='message'` 事件落 events 表 → UI 当纯文本渲染 → 工具**从未执行**。

## 变更内容

- `package.json`：`@anthropic-ai/claude-agent-sdk` `^0.3.144` → `^0.3.158`
- `pnpm-lock.yaml`：锁定 0.3.158 + 8 个平台 native pkg 同步；`postinstall` 重建 better-sqlite3 against Electron 33.4.11（无 ABI landmine）

## DB forensics（修正旧「损坏调用不落 DB」错误结论）

**损坏的工具调用 DOES 落 DB**，以 `kind='message'` + `role='assistant'` 存储（不是「不落 DB」）。

- 干净信号：`kind='message'` + `payload_json LIKE '%invoke name=%'`（FTS 搜 `malformed` 被本次调查 narration 污染不可信，1091 命中多为噪声）
- 11 条真实损坏全部集中在**单一会话 07427f50**（13:02→15:32，即卡死 2.5h 的会话）
- `id=329524`：就是「升级 package.json 的 Edit」那条——`court` 损坏 → 未执行 → **这就是接力时 package.json 仍停在 `^0.3.144` 的根因**
- `id=329520`：同款 `court` 损坏，杀掉的是 DB 只读查询

## Spike 对照（standalone `query()` 无法复现）

runner 复刻应用真实 `query()` 调用方式（model 透传 / `systemPrompt:{preset:'claude_code'}` / settingSources / canUseTool / 多轮 streaming input）。

- 0.3.144：caseA/A2/A3/A4 + caseB3/B4 + multiA_144 共 7 run → 全 **0 malformed**
- 0.3.158：multiB_158（多轮 streaming，6 tool calls / 5 turns）→ **0 malformed**（无回归）
- 结论：standalone 0.3.144 与 0.3.158 **都 0 复现**，bug 仅真实 app 长会话出现 → 升级无法在 spike 证明 fix

## 验证

- `pnpm typecheck` ✅ / `pnpm build` ✅
- lockfile 0 处残留 `0.3.144` 引用；native darwin-arm64 0.3.158 已 link（`.pnpm` 残留 `*0.3.144` 孤儿目录下次 store prune 回收，不被打包/运行）

## 残留风险

1. **running app 仍是 0.3.144**：node_modules 已 0.3.158，但运行中进程是启动时加载的 SDK，**必须重启**（dev 重启 `pnpm dev`；packaged `pnpm dist` 重新打包覆盖安装）才加载 0.3.158
2. **fix 未证明**：无 standalone repro → 真实验证只能靠重启 + 长会话实跑观察
3. **假设（*未验证*）**：malformed 率与「累积上下文长度 / MCP tool 数量 / system prompt 体积」正相关（唯一爆发会话 07427f50 是 2.5h 长会话 + thinking-max 模型；spike 短上下文 0 复现）
4. **若升级后仍复现**：区分模型侧（thinking-max 长上下文解码自身 special token 损坏 → SDK 无法修，需换模型/砍上下文/等 Anthropic 修）vs CLI 侧（解析容错不足 → 追更高 SDK）。plan 名带 `thinking` + 爆发会话用 thinking-max → 模型侧嫌疑更大（*未验证*）

> spike 全程详 `.claude/plans/sdk-upgrade-thinking-fix-20260530/spike-reports/spike1-malformed-tool-call-and-sdk-upgrade.md`（plan 完成后随 archive_plan 归档进 `ref/plans/`）。
