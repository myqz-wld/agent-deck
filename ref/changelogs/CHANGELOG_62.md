# CHANGELOG_62: R1.D 阶段 — Codex 配置生态对齐 Claude（plan v3 落地，4 commit）

## 概要

实施 plan v3 R1 第二阶段：把 Agent Deck 自带的 CLAUDE.md / plugin skills 三件套
在 codex 一侧建等价物（AGENTS.md + ~/.codex/skills/agent-deck/），让 codex 会话
也能享受 Agent Deck 的项目通用约定 + skill 触发能力。本次 4 个 atomic commit
覆盖 D1（AGENTS.md 注入）+ D5 决策实现 + D2（skills 同步）+ D4（Settings UI），
D6 (packaging) 检查无需改动；剩 D3（reviewer-* 改写为 codex skill 内容创作）
+ D7（codex-runtime config，dep R2.B'4）作为后续 follow-up。

## 变更内容

### D1 (+ D5): AGENTS.md 注入 Agent Deck 段（marker 包裹）

`src/main/codex-config/agents-md-installer.ts`（新建）：

- `syncAgentDeckSection()`：把内置 CLAUDE.md 内容（用户副本 → 内置回落）写到
  `~/.codex/AGENTS.md` 的 `<!-- === Agent Deck START - DO NOT EDIT THIS BLOCK === -->`
  / `<!-- === Agent Deck END === -->` marker 段。
- HTML 注释 marker：codex parse AGENTS.md 当 markdown，注释**不影响渲染**也不影响
  prompt（codex CLI 把整个 AGENTS.md 拼到 system prompt，注释行作为字符出现但不会
  触发任何特殊行为）。
- 用户手写的其他段（marker 之外）严格保留。
- 自愈：marker 缺失 / 损坏 / 用户删了 → 下次启动追加新段。
- atomic write（write tmp + rename）防进程崩溃 / 磁盘满留半截。
- 内存缓存 + invalidate（与 sdk-injection.ts 同模式）。

**D5 决策（用户拍板）**：单向 overwrite Agent Deck 段，用户在 Agent Deck 段内
手改不反向同步——下次启动同步会被覆盖（marker 段是 Agent Deck 自管区域）。

### D2: skills 同步到 ~/.codex/skills/agent-deck/

`src/main/codex-config/skills-installer.ts`（新建）：

- `syncSkills()`：镜像内置 plugin skills（含 `deep-code-review` /
  `hello-from-deck`）到 `~/.codex/skills/agent-deck/<name>/SKILL.md`。
- `agent-deck/` 命名空间前缀：避免与用户手写的 `~/.codex/skills/<X>/` 撞名。
- mtime 对比：仅源文件 mtime > 目标 mtime 才覆盖（避免每次启动写一遍）。
- 删除规则：源里没的 skill 在目标也删（保持镜像一致）。
- 关 toggle → 移除整个 `agent-deck/` 子目录（保留用户其他 skills）。
- dev / packaged 路径自动分流（与 sdk-injection 同模式）。

未实现：chokidar 监听源 skills hot reload（dev 重启即可）；skill 内 references/
子目录递归同步（目前 skills 都没 references；future 加时再扩）。

### D4: Codex 注入 Settings UI section

`src/renderer/components/settings/sections/CodexInjectionSection.tsx`（新建）+ 挂到
`SettingsDialog.tsx`：

- 两个 toggle：`injectAgentDeckCodexAgentsMd` / `injectAgentDeckCodexSkills`
- 文案说明 marker 包裹策略 + 关闭后的清理行为
- 提示「下次新建 codex 会话生效」

### D5: 同步策略 ADR（合并到 D1 实现）

用户决策：单向 overwrite Agent Deck 段，用户段（分隔符外）严格保留。决策细节
直接落到 D1 模块顶部 JSDoc，不单独出 ADR 文档（避免文档碎片化）。

### D6: packaging（无需改动）

检查 `package.json build.extraResources` 已含 `resources/claude-config` →
`.app/Contents/Resources/claude-config`。D1/D2 共享 `getBuiltinClaudeMdPath()` /
`getBuiltinSkillsSourceDir()` 路径分流逻辑（dev → repo / prod → resourcesPath），
zero new packaging 项需要加。

### settings 集成

`src/shared/types/settings.ts`：

- 新增 `injectAgentDeckCodexAgentsMd: boolean`（默认 true）
- 新增 `injectAgentDeckCodexSkills: boolean`（默认 true）
- 默认值集成到 `DEFAULT_SETTINGS`

`src/main/ipc/settings.ts`：

- 新增 `applyCodexAgentsMd` / `applyCodexSkills` apply* helpers（动态 import
  installer 调 sync 函数）
- 加进 `APPLY_FNS` 数组

`src/main/index.ts` bootstrap step 7.0：

- app ready 后调一次 `syncAgentDeckSection()` + `syncSkills()`（首次启动 / 升级后
  让 marker 段 / 镜像目录写入到位）

## 备注

- 本批未做 R1.D3（reviewer-* 改写为 codex skill 形态）—— 内容创作工作（写
  reviewer-codex / reviewer-claude 的 codex skill 版 SKILL.md），不影响 D2
  同步通路本身。建议在用户实际跑 codex 会话需要 reviewer-* 时再创作内容。
- 本批未做 R1.D7（`<userData>/codex-runtime/config.toml` 与用户主 config 协同）
  —— dep R2.B'4（Agent Deck MCP server 通过 codex 自动注入）才能跑通端到端，
  留 R2 周期。
- 关联 plan：`/Users/apple/.claude/plans/magical-puzzling-muffin.md` v3
- commit 链路：`785e5f5` (D1) / `d0693b0` (D2) / `44ad9e4` (D4) / 本 changelog
