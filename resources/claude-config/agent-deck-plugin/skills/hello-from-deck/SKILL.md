---
name: hello-from-deck
description: Agent Deck 内置 skill 自检。当用户调用 /agent-deck:hello-from-deck 或问 "agent deck 在吗" / "deck 自检" 时触发，用于验证 plugin 加载链路。
---

# Hello From Deck

用于验证 Agent Deck 应用打包并通过 SDK `plugins` 字段注入的 skill 链路是否正常。

## 触发条件

- 用户显式调用 `/agent-deck:hello-from-deck`
- 用户问 "agent deck 在吗" / "deck 自检" / "确认一下 agent-deck plugin 加载了吗"

## 步骤

1. 回复一句确认消息：`Agent Deck 自带 skill 已就绪：hello-from-deck`
2. 同时附上当前会话 cwd 与时间戳，方便用户核对（用 Bash `pwd` + `date` 取，或直接复用上下文里的信息）
