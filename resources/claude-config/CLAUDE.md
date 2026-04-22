<!--
此文件由 Agent Deck 应用打包并自动注入到每个 SDK 会话的 system prompt 末尾，
独立于 user/project/local CLAUDE.md（位置在三者之后）。
跟随 agent-deck 仓库走（git 管理），不依赖会话 cwd。
-->

- 始终使用中文回复
- 不要创建 .md 文件，除非我明确要求
- Go 版本通过 gvm 管理，Golang 项目中请使用项目对应的 Go 版本
- Node 用 nvm 管理；跑 node/npm/pnpm/bun/npx 一律走 `zsh -i -l -c "..."`（登录式 zsh，否则缺 brew / path_helper 注入的 PATH，与真实 Terminal 不一致），不要只 `-i`。禁止手动拼 PATH 或 source nvm.sh
- 给代码下结论（bug / 优化 / code review / 安全 / 架构 / 根因）前，必须并发两个独立对抗 Agent 各自读真实代码核实，三态裁决（✅ 确认 / ❌ 反驳 / ⚠️ 部分），证据须带 `文件:行号` + 代码片段，不准复述。最终清单标注被反驳 / 升降级条目。trivial 改动（typo / 样式数值）除外
