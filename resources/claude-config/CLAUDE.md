<!--
此文件由 Agent Deck 应用打包并自动注入到每个 SDK 会话的 system prompt 末尾，
独立于 user/project/local CLAUDE.md（位置在三者之后）。
跟随 agent-deck 仓库走（git 管理），不依赖会话 cwd。

内容必须与 ~/.claude/CLAUDE.md 保持一致；改一处必须同步另一处。
-->

# 通用约定

## 输出

- 始终使用中文回复
- 不要主动创建 .md 文件（除非明确要求）

## 运行时

- **Go**：项目用对应版本（gvm 管理）
- **Node / npm / pnpm / bun / npx**：一律走 `zsh -i -l -c "..."`（登录式 zsh 才能拿到 brew / path_helper 注入的 PATH，与真实 Terminal 一致）。禁止只 `-i`，禁止手动拼 PATH 或 source nvm.sh
- **macOS 没有 `timeout` / `gtimeout` 命令**：禁止在 Bash 命令里写 `timeout 5m ...` / `gtimeout ...`，会让整条命令（含分号 / 管道串起来的后续命令）一起 `command not found` 跟着崩。**超时只走 Bash 工具调用本身的 `timeout` 参数**（毫秒，上限 600000）。任何阻塞命令都适用，不要被 Linux 习惯带偏

## 决策对抗（下结论 / 出 plan / 升级约定前必做）

**适用范围**（任一即触发）：
- 给代码下定性判断：bug / 优化 / code review / 安全 / 架构 / 根因
- 出执行计划（plan）
- **升级「约定」/「规范」到全局生效**（如把候选条目升到 CLAUDE.md 项目约定）
- 重要技术选型 / 重构方向决策
- **例外**：trivial 改动（typo / 样式数值 / 单点 rename / 显然措辞修订）

**操作**：并发两个独立异构 Agent，各自读真实代码 / 资料给结论：
- **异构原则**：两个 Agent 必须**不同源**（不同 SDK / 不同模型 / 不同 reasoning 路径），最大化降低同源偏见。具体怎么配对由用户工具链决定，本约定不写死
- **典型配对方式**：当前 Claude Code 会话内的 subagent（Explore / general-purpose）+ Bash 调外部 CLI Agent（不同厂商 / 不同模型）。两个都走"读真实代码 + 给证据 + 不复述"
- **三态裁决**：✅ 确认 / ❌ 反驳 / ⚠️ 部分。每条结论必须带 `文件:行号` + 代码 / 原文片段，不准复述
- 最终清单标注被反驳 / 升降级条目；plan 场景标注哪些步骤双方一致、哪些有分歧；约定升级场景额外评审措辞 / 边界 / 与已有约定的冲突

**外部 Agent 不可用时**（CLI 失联 / `Reconnecting...` / 超时 / OAuth 过期 / 二进制缺失）：**不要自动降级**到同源双 Agent，**提示用户**「外部对抗 Agent 当前不可用（具体原因），是降级到同源双 Agent、单方出结论、还是稍后重试？」由用户决定

---

## 附录：外部 CLI 对抗 Agent 调用通用姿势

使用任何外部 CLI 作为对抗 Agent 时，注意几条通用工程姿势（具体到 codex CLI 的细节见下面小节，其他 CLI 类比）：

- **用登录式 shell 包外层**（macOS：`zsh -i -l -c "..."`），否则缺 brew / nvm / path_helper 注入的 PATH，与真实 Terminal 不一致
- **强制非交互模式**（一般是 `exec` / `--non-interactive` / `--batch` 之类 flag）
- **沙箱限只读 + 跳过 git repo 检查**（避免 CLI 在你的 repo 里乱 commit）
- **显式传项目绝对路径**（`-C` / `--cwd` / `--workdir`）
- **分离最终答案与日志**：很多 CLI 的 stdout 是 banner + reasoning + final 的混乱混合（且 final 可能重复多次），必须用 `-o <OUT_FILE>` 之类把最终答案抓到独立文件
- **reasoning effort 尽可能高**（review / plan / 探索类用最高档；简单 yes/no 核查可临时降档省时间，但**宁可慢别错**）
- **长 prompt 走 stdin**（避免 argv 长度限制和 shell 转义陷阱），prompt 里**写死要读的文件绝对路径**，不让 CLI 自由 grep / explore
- **多子问题拆并发或合并精简**，要求 yes/no + 一两行证据，不要大段结构化报告
- **超时只走 Bash 工具的 `timeout` 参数**（命令本体绝不能出现 `timeout` / `gtimeout`，见上 macOS 节）。重 review / 探索类给 5-10 分钟（300000-600000 ms），轻量核查 1-2 分钟即可

### codex CLI 具体姿势

如果对抗配对里用了 codex CLI（默认走 `~/.codex` 配置，模型 / approval / OAuth 等都在那里）：

```bash
OUT=$(mktemp); PROMPT=$(mktemp)
cat > "$PROMPT" <<'EOF'
... 你的 prompt ...
EOF
zsh -i -l -c "codex exec --sandbox read-only --skip-git-repo-check \
  -c model_reasoning_effort=\"xhigh\" \
  -C <REPO_ABS_PATH> -o '$OUT' - < '$PROMPT'"
cat "$OUT"; rm -f "$OUT" "$PROMPT"
```

（Bash 工具调用时给 `timeout: 300000`，重 review 给 600000；轻量核查可降到 90000；reasoning effort 简单核查可降 `"low"`，宁可慢别错）
