<!--
此文件由 Agent Deck 应用打包并自动注入到每个 SDK 会话的 system prompt 末尾，
独立于 user/project/local CLAUDE.md（位置在三者之后）。
跟随 agent-deck 仓库走（git 管理），不依赖会话 cwd。
-->

- 始终使用中文回复
- 不要创建 .md 文件，除非我明确要求
- Go 版本通过 gvm 管理，Golang 项目中请使用项目对应的 Go 版本
- Node 用 nvm 管理；跑 node/npm/pnpm/bun/npx 一律走 `zsh -i -l -c "..."`（登录式 zsh，否则缺 brew / path_helper 注入的 PATH，与真实 Terminal 不一致），不要只 `-i`。禁止手动拼 PATH 或 source nvm.sh
- 给代码下结论（bug / 优化 / code review / 安全 / 架构 / 根因）前，必须并发两个独立对抗 Agent 各自读真实代码核实：默认一个 Claude（Explore / general-purpose subagent）+ 一个 Codex（Bash 直接调 codex CLI，调用模板见下一条；不走 codex-custom subagent 包装），异构对抗最大化降低同模型偏见；codex CLI 不可用时降级两个独立 Claude Agent。三态裁决（✅ 确认 / ❌ 反驳 / ⚠️ 部分），证据须带 `文件:行号` + 代码片段，不准复述。最终清单标注被反驳 / 升降级条目。trivial 改动（typo / 样式数值）除外
- codex CLI 调用约定（通用）：codex 装在 nvm 路径，必须 `zsh -i -l -c`；非交互 oneshot 用 `codex exec`，必加 `--sandbox read-only` + `--skip-git-repo-check` + `-C <项目绝对路径>` + `-o <OUT_FILE>`（最终回答只在 `-o` 文件里）+ `-c model_reasoning_effort="low"`（核查 / yes-no 类，xhigh 只留给探索 / 设计）；长 prompt 走 stdin（`- < <PROMPT_FILE>`）；prompt 里写死要读的文件绝对路径，不让 codex 自由 grep / explore；多子问题拆并发或合并精简，要求 yes/no + 一两行证据，不要大段结构化报告；用 `timeout <秒数>` 或 Bash 工具 timeout 参数包住 codex exec（核查类 60-90s 足够），看到 `Reconnecting... N/5` 立即降级到双 Claude Agent。骨架：`OUT=$(mktemp); PROMPT=$(mktemp); cat > "$PROMPT" <<'EOF' ... EOF; zsh -i -l -c "codex exec --sandbox read-only --skip-git-repo-check -c model_reasoning_effort=\"low\" -C <REPO_ABS_PATH> -o '$OUT' - < '$PROMPT'"; cat "$OUT"; rm -f "$OUT" "$PROMPT"`。默认 model=gpt-5.4 / approval=never / OAuth 已在 `~/.codex` 自带
