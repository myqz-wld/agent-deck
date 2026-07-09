# CHANGELOG_126 — 复杂 plan 流程 v2 升级（RFC + spike + Deep-Review 前置 / SKILL 改名 + sandbox cp / 4 reviewer body sandbox 限制说明）

## 概要

Plan codex-handoff-team-alignment-20260518 P6 流程改进收口（CHANGELOG_125 P5 收口的姊妹篇）—— 沉淀本 plan v1→v4.1 写作流程暴露的问题到流程资产：升级 user CLAUDE.md §复杂 plan 节为 v2 流程图（RFC + spike + Deep-Review 前置 + user confirm 进 worktree），4 reviewer body 加 sandbox 限制说明，重命名 deep-code-review → deep-review SKILL（保留老名作 6 个月 deprecation stub），加 typed scope kind + auto sandbox cp + manifest。

P6.5 meta-review 双对抗（reviewer-claude + reviewer-codex）共 5 HIGH + 13 MED + 3 LOW，全部 inline fix。详 [`plans/codex-handoff-team-alignment-20260518.md`](../../plans/history/codex-handoff-team-alignment-20260518.md) §P6 章节。

## 变更内容

### A. user CLAUDE.md §复杂 plan 节升级 v2（plan §P6.1 — 4 sub-step 含 dry-run / ack / backup / Edit）

**新流程总览**（v2，相对 v1 关键变化 5 点）：
- Step 0 §RFC 前置（agent 主动 AskUserQuestion 多轮对齐 design 大方向 / 不变量 / 边界）
- Step 0.5 §spike 前置（agent 写 mini-runner 实测 SDK / lib 行为，输出 spike-reports/）
- Step 1 §Plan 文件 hand off（agent Write plan 文件 inline RFC + spike 结论）
- Step 1.5 §Deep-Review（agent invoke `/agent-deck:deep-review` SKILL，reviewer 出 finding fix 直到通过）
- Step 2 §EnterWorktree（**user confirm 后** agent 进 worktree，不再是 plan 写作前置）
- Step 2.5 / Step 3 / Step 4 同款（cross-ref 更新）

**§触发条件 v2 拓宽**：
- bullet 1 子条件追加「OR 含不确定 design / SDK 行为未知 / 需 spike 才能完成设计」
- bullet 2 不变（破坏性 / 实验性改动）
- 新增 bullet 3「跨 adapter / 跨 schema / 跨进程边界改造」

**P6.5 reviewer-codex MED-1 修法**：§Step 2 EnterWorktree 主指令改成 stale-base-bug 主路径 (b) 形式（Bash + EnterWorktree(path:)）— 与 §EnterWorktree CLI stale base bug callout 一致，不再写 `EnterWorktree(name:)` 主指令与同节禁用矛盾。

### B. 应用 CLAUDE.md (resources/claude-config/CLAUDE.md) cross-ref（plan §P6.2 最小动）

- 顶部加 cross-ref 一句指向 user CLAUDE.md §复杂 plan / §RFC 前置 / §spike 前置 / §Step 1.5 Deep-Review
- §应用环境 RFC / spike 差异 节明示「与 user CLAUDE.md 同款，本应用环境无 SDK 会话专属差异」（P6.5 reviewer-codex LOW-2 修法 — 删 placeholder「未来如有...在此填充」违反约束 2）
- `mcp__agent-deck__enter_worktree` 调用签名改 `base_commit / base_branch / plan_file_path` 实际 schema（P6.5 reviewer-codex MED-D 修法）
- `mcp__agent-deck__archive_plan` 调用签名 `base_branch?: <plan frontmatter.base_branch ?? "main">` 准确表述（P6.5 reviewer-codex LOW-1 修法）
- `mcp__agent-deck__hand_off_session` 调用签名补 `archive_caller?: true`（P6.5 reviewer-claude MED-A + reviewer-codex MED-3 双方独立修法）
- §Step 2 cross-ref 改正（user CLAUDE.md §Step 2 EnterWorktree §EnterWorktree CLI stale base bug callout）

### C. 4 reviewer body §Sandbox 限制说明节（plan §P6.3 — 4 file 覆盖 claude-config × {claude,codex} + codex-config × {claude,codex}）

**claude-config 视角**（P6.5 reviewer-claude HIGH-D 修法 — 实测 SDK sandbox 边界）：
- READ 默认宽松：`denyRead` 仅 `~/.ssh / ~/.aws / ~/.config` 等敏感凭据
- WRITE 默认严格：`allowWrite = [cwd, /tmp, ~/.cache/claude-code, extraAllowWrite]`
- macOS Seatbelt 是 OS 层独立限制（非 SDK 层）
- caller 责任分流：走 SKILL auto cp 兜底真撞 sandbox 拒的场景；绕开 SKILL 时 caller 自己处理

**codex-config 视角**：codex sandbox `workspace-write + additionalDirectories=['~/.claude','~/.codex','/tmp']` default + 双层 sandbox 嵌套行为说明 + caller 走 SKILL / 绕开 SKILL 责任分流

**P6.5 reviewer-codex MED-F 修法**：claude-config reviewer-codex.md:107 输出格式 4 档漏 INFO → 加 INFO 第 5 档对齐其他 3 reviewer body 的 5 档 invariant
**P6.5 reviewer-codex MED-H 修法**：codex-config reviewer-claude.md cwd 表述与 §claude CLI 调用模板矛盾 → 改成"wrapper Bash 模板固定切 cwd 到 `<CWD>`（子 shell `cd <CWD>`），不切到 scope 所在目录"
**P6.5 reviewer-codex LOW-3 修法**：codex-config reviewer-codex.md "default 三目录" 与 worktree 概念混淆 → 改成"sandbox 默认允许的位置之一（worktree 内 / `~/.claude` / `~/.codex` / `/tmp` 任一）"

### D. deep-code-review SKILL 改造 + 物理改名 → deep-review（plan §P6.4 + §P6.7 user confirm 后）

**SKILL.md content 改造**（plan §P6.4a）：
- typed scope schema：`{ kind: 'code' | 'plan' | 'mixed', paths: string[] }` — caller 显式传 kind 不依赖 path 后缀启发
- 3 套 prompt 模板（kind=code / plan / mixed 各自 focus 维度）
- §kind='mixed' 成本与失败兜底（P6.5 reviewer-claude HIGH-C 修法 — 选 (a) 2 reviewer × 2x scope 设计 — 同一对 reviewer 拼合并 prompt 同时审 code + plan，成本 2x token + 2x time per reviewer 不是 spawn 4 reviewer；任一 reviewer fail 不阻塞，缺失方丢失整 reviewer，finding 降级单方非 HIGH）
- §Sandbox 处理 节（auto cp + manifest，plan §P6.4b 落地）：
  - cache file 命名升级到 `<worktree>/.deep-review-cache/<invocationId>/<fileSha8>-<basename>.md`（P6.5 reviewer-claude HIGH-B 修法 — 加 `<invocationId>` 子目录隔离防并发 race；P6.5 reviewer-claude MED-C 修法 — `<invocationId>` 与 `<fileSha8>` separate placeholder 不复用 sha8 名称）
  - manifest 放 invocation 子目录内 `<worktree>/.deep-review-cache/<invocationId>/manifest.json`
  - cleanup 走 `rm -rf <invocationId>/` 子目录粒度（不影响别 invocation 的 cache files）
  - SKILL 启动 step 0 sweep > 24h orphan invocation 子目录（P6.5 reviewer-claude MED-E 修法 — 防中断 SKILL 留 orphan 累积）
  - 包 try/finally 保 cleanup 失败也尝试 rm 一遍

**SKILL 物理 git mv**（plan §P6.7b user confirm 后）：
- `git mv resources/claude-config/agent-deck-plugin/skills/deep-code-review resources/claude-config/agent-deck-plugin/skills/deep-review`
- 新 SKILL `frontmatter name: deep-review`
- 老 `skills/deep-code-review/` 重建作 deprecation stub（frontmatter description 明示已重命名 + 6 个月后版本移除 + 触发关键词兼容）
- 5 处文档（user CLAUDE.md 3 处 + 4 reviewer body 4 处）slash 命令统一为 `/agent-deck:deep-review` + 加 P6.7 改名注释

**P6.5 reviewer-claude HIGH-A 修法**（chicken-egg 反向问题）：原 plan §P6.4a 把 `frontmatter name=deep-code-review` 与 5 处文档 `/agent-deck:deep-review` 混搭，meta-review 揭示 docs 不能比 SKILL 物理名先升级。修法选 (a) 现在 mv（合并到 P6.7 work），所有 docs 同步新名 + deprecation stub backward-compat。

### E. .gitignore 加 .deep-review-cache/（P6.5 reviewer-claude HIGH-E 修法）

- `.gitignore` 加 `.deep-review-cache/` entry，与 `.claude/worktrees/` `.claude/scheduled_tasks*` 等 per-session state 同列
- worktree 内 cache 目录及子目录全不入 git；ff-merge 回 base_branch 时也不污染

### F. 测试缺口 + 旧 review 残留 polish

- 不变量：本 P6 改动全 .md，无 typecheck 影响
- meta-review 验证：双对抗 reviewer (`reviewer-claude` + `reviewer-codex`) 共 5 HIGH + 13 MED + 3 LOW + 1 ❌ false positive (reviewer-claude 误以为 spike4 文件不存在，实际 spike4-claude-nested-sandbox.md + spike4-runner.mjs 都在 spike-reports/)，全部 inline fix

## 不变量

- **§复杂 plan 流程 v2**：触发 → RFC → spike → 写 plan → Deep-Review → user confirm → EnterWorktree → 实施 → 完成
- **SKILL typed scope schema**：caller 显式传 `{ kind, paths }`，不依赖 path 后缀启发
- **SKILL Sandbox 处理 race-free**：每次 invocation 独立 `<invocationId>/` 子目录，cleanup 子目录粒度
- **6 个月 deprecation 期**：老 `/agent-deck:deep-code-review` 仍 resolve 到 stub（指向新名）

## Migration 路径

- 既有 plan 走 `/agent-deck:deep-code-review` 触发 → 走 stub 提示，自动指引到 `/agent-deck:deep-review`
- 自然语言触发关键词新 SKILL 完全兼容（同款触发列表 + 新加 plan/RFC/mixed 关键词）
- 6 个月（2026-11-19 后）可移除 `skills/deep-code-review/` stub 目录

## 验证

- `pnpm typecheck`：0 错（P6 改动全 .md）
- meta-review：reviewer-claude 5 HIGH 全验证（4 SDK 实测 + 1 工具实测 git status / .gitignore） + reviewer-codex 9 MED 全文本 grep / sed 验证
- P5 既有验证基线不动（730/801 vitest 0 failed）

## 关联 plan

- 主 plan：`plans/codex-handoff-team-alignment-20260518.md`（archive 后落 plans/ 入 git）
- P5 收口 changelog：[CHANGELOG_125.md](./CHANGELOG_125.md)（codex-cli adapter 全面接入 hand_off / archive_plan / team mcp 编排）
- 后续：archive_plan 一次性收口（P6.8）含 changelog_id csv 125,126
