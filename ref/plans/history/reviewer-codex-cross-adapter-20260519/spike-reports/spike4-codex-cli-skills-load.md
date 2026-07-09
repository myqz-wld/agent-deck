# Spike 4 — Codex CLI 加载 ~/.codex/skills/agent-deck/ 实测

**日期**：2026-05-19
**plan_id**：reviewer-codex-cross-adapter-20260519
**spike 目标**：验证应用 skills-installer 把 `resources/claude-config/agent-deck-plugin/skills/` 镜像到 `~/.codex/skills/agent-deck/<skill-name>/SKILL.md` 后，codex CLI 在 interactive 模式 `/skills` 能列出 + 选用后能正确触发 SKILL context 注入。

## 方法

分两步：

1. **fs check（我跑）**：检查 `~/.codex/skills/agent-deck/` 物理目录是否存在 + SKILL.md 文件是否正确同步（间接验证 skills-installer 工作）
2. **interactive /skills 实测（user 跑）**：user 在 terminal 里跑 `codex` 进 interactive 模式 → 输 `/skills` → 看 `deep-review` / `hello-from-deck` 是否在列表里 → 选 deep-review 看 SKILL context 是否被注入下一轮请求

## 实测

### 第 1 步 fs check ✅ PASS

```bash
$ ls -la ~/.codex/skills/agent-deck/
drwxr-xr-x  4 apple  staff  128 May 19 20:11 .
drwxr-xr-x  4 apple  staff  128 May 19 21:25 ..
drwxr-xr-x  3 apple  staff   96 May 19 20:11 deep-review
drwxr-xr-x  3 apple  staff   96 May 12 11:05 hello-from-deck

$ find ~/.codex/skills/agent-deck/ -name "*.md" -maxdepth 3
/Users/apple/.codex/skills/agent-deck/hello-from-deck/SKILL.md
/Users/apple/.codex/skills/agent-deck/deep-review/SKILL.md
```

- `~/.codex/skills/agent-deck/deep-review/SKILL.md` ✅ 存在
- `~/.codex/skills/agent-deck/hello-from-deck/SKILL.md` ✅ 存在
- skills-installer.ts:67-156 `syncSkills()` 工作正常

同目录还存在 codex CLI 自带的 `~/.codex/skills/.system/` 系统 skills 集（codex 自管，不动）— skills-installer 用 `agent-deck/` 命名空间前缀避免与 codex 自带撞名（skills-installer.ts:12 注释「`agent-deck/` 命名空间前缀：避免与用户手写的 `~/.codex/skills/<X>/` 撞名」）。

### 第 2 步 codex CLI 暴露面探查

```bash
$ codex --help    # 含 plugin / mcp / mcp-server / 等顶层 subcommand
$ codex skills    # 不存在 skills 顶层 subcommand，被走到 interactive 模式
$ codex plugin --help  # 只含 marketplace 子命令，无 plugin list
```

codex CLI **不暴露非交互的 list-skills 命令** — `/skills` 是 interactive 模式下的 slash command。我（agent）作为 claude SDK 跨进程跑 Bash 起不了 interactive shell + 跟它持久交互，所以**第 2 步必须 user 在 terminal 手动跑**。

## 结论

### ✅ skills-installer 同步层 PASS

应用 skills-installer 工作正常，SKILL.md 物理位置正确同步。这层是我们应用层能控的，已实证。

### ✅ codex CLI interactive `/skills` 加载层 — user 实测铁证 PASS（2026-05-19 21:37 截图）

**实测路径**（user 在 terminal 跑 codex interactive）：

1. `/hello-from-deck` slash command explicit invocation → codex 自动识别 SKILL（21:36:38）
2. codex 回「我会使用 `hello-from-deck` skill 做一次加载自检」（21:36:44）
3. codex `cat ~/.codex-default/skills/agent-deck/hello-from-deck/SKILL.md`（21:36:45）读取 SKILL 内容
4. codex 按 SKILL 指引跑 `pwd && date '+%Y-%m-%d %H:%M:%S %Z'`（21:36:51）
5. codex 输出「Agent Deck 自带 skill 已就绪：hello-from-deck / cwd: /Users/apple/Repository/personal/agent-deck / 时间戳：2026-05-19 21:36:51 CST」（21:37:03 ✅）

**实证条目**：

- ✅ codex CLI **自动 detect `~/.codex/skills/agent-deck/<X>/` 嵌套命名空间**（关注点 1 解除）
- ✅ slash command `/hello-from-deck` **explicit invocation** 路径 work
- ✅ SKILL.md frontmatter 兼容（关注点 2 解除）
- ✅ SKILL 内部指令被 codex 正确执行（关注点 3 解除 — 至少对 trivial SKILL hello-from-deck 成立）
- ⏳ deep-review SKILL 实际触发后能否按编排 spawn cross-adapter reviewer pair — 受 spike 1+2 dispatch BLOCKER 影响，需 dispatch 修完后再实测

**alt codex home 发现**：

user 截图里 codex CLI cat 的路径是 `~/.codex-default/skills/agent-deck/hello-from-deck/SKILL.md`，不是 `~/.codex/skills/agent-deck/`。fs check 显示两个目录 **inode 同一**（335950）— `~/.codex` 是 `~/.codex-default` 的 alias（symlink 或 hardlink，user 多 profile 切换习惯）。skills-installer 写 `~/.codex/skills/agent-deck/`，codex CLI 通过 alt path 读到同一份 SKILL.md，所以 spike 4 PASS 结论不受影响。


按 OpenAI 官方文档承诺（搜索结果 [Agent Skills – Codex](https://developers.openai.com/codex/skills)）：

> Codex detects newly installed skills automatically; if one doesn't appear, restart Codex.
>
> Type /skills. Pick the skill you want Codex to apply. Expected: Codex inserts the selected skill context so the next request follows that skill's instructions.

按文档承诺：`~/.codex/skills/agent-deck/<X>/SKILL.md` 应该被 codex CLI 自动识别 + 在 `/skills` 列表显示 + 选用后注入 context。这是 OpenAI 实现，我们应用层不控；按文档承诺 work，但实证留给 user 配合（user 起 codex CLI interactive 输 `/skills`）。

### 已知关注点（需 user 实测确认）

1. **嵌套命名空间是否被识别**：我们用 `~/.codex/skills/agent-deck/deep-review/SKILL.md`（agent-deck/ 命名空间嵌套 1 层）；OpenAI 文档说 `~/.codex/skills/<X>/SKILL.md`（无明示嵌套层）。codex CLI 是否扫嵌套 1 层目录识别 SKILL，需实证。
   - 备用方案：若不识别，把 skills-installer 改成把 SKILL 镜像到 `~/.codex/skills/agent-deck-<skill-name>/SKILL.md`（用前缀连字符而非嵌套子目录），保持唯一性 + 兼容 codex CLI 扫描预期。
2. **SKILL.md frontmatter 兼容性**：OpenAI 文档说 SKILL.md 必须含 `name + description`。我们的 SKILL.md frontmatter 全含（claude SKILL frontmatter spec 同款），应该兼容。
3. **触发后能否真应用 SKILL context**：user 选 `/skills` 中的 deep-review 后，下一轮请求 codex 是否真按 SKILL.md 指引行事（如「invoke `mcp__agent-deck__spawn_session`」等 SKILL 内部约束）。

## 影响 plan

1. plan **不必再做** SKILL 加载/触发的实测 checkpoint（spike 4 user 实测已铁证 codex CLI 加载 + slash command explicit invocation work）
2. plan **不必备** 「`~/.codex/skills/agent-deck/<X>/` 嵌套命名空间是否被 codex CLI 扫到」的 fallback 方案（关注点 1 已被实证解除）
3. plan 中 deep-review SKILL 真实编排实测仍需做 — 但前置 prerequisite 是 spike 1+2 dispatch BLOCKER 解决（Phase 0）；BLOCKER 解决后跑 cross-adapter deep-review 闭环回归

## 限制

- spike 4 实测仅覆盖 trivial SKILL（hello-from-deck，几行 SKILL 内部指令）；deep-review SKILL 编排更复杂（含多步 spawn / send_message / 三态裁决），需 dispatch BLOCKER 修完后再独立实测
