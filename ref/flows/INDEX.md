# Flow Diagrams

> plantUML 流程图(sequence / activity)SSOT。规则见应用打包 CLAUDE.md §核心流程 / 架构变更必走 plantUML 节;画图规约见 `agent-deck:flow-arch-plantuml` SKILL。

| 文件 | 状态 | 关联 plan / commit | 概要 |
|---|---|---|---|
| [agent-deck-mcp-tool-call-flow.puml](agent-deck-mcp-tool-call-flow.puml) | active | commit 7475b75 + d5549c6 / [REVIEW_59](../reviews/REVIEW_59.md) | MCP tool 调用 sequence(4 段:入口/拦截/业务路由/收口) |
| [archive-plan-flow.puml](archive-plan-flow.puml) | active | commit d5549c6 / [REVIEW_59](../reviews/REVIEW_59.md) / [REVIEW_64](../reviews/REVIEW_64.md) | archive_plan 4 子模块原子收口 sequence(precheck fail-fast + post-ff-merge manual recovery + cleanup) |
| [archive-plan-precheck-decision.puml](archive-plan-precheck-decision.puml) | active | commit d5549c6 / [REVIEW_59](../reviews/REVIEW_59.md) / [REVIEW_64](../reviews/REVIEW_64.md) | archive_plan 决策树(3 段:precheck 8 分支/4 子模块收口/baton cleanup) |
| [hand-off-session-flow.puml](hand-off-session-flow.puml) | active | commit d5549c6 / [REVIEW_59](../reviews/REVIEW_59.md) | hand_off_session baton sequence(4 段:cwd/分流/spawn+adopt+task/cleanup) |
| [hand-off-session-decision.puml](hand-off-session-decision.puml) | active | commit d5549c6 / [REVIEW_59](../reviews/REVIEW_59.md) | hand_off_session 决策树(3 段:双模式分流/spawn+adopt/cleanup) |
| [sdk-bridge-resume-recovery-flow.puml](sdk-bridge-resume-recovery-flow.puml) | active | commit 627a0c2 + 5b66cd8 / [REVIEW_60](../reviews/REVIEW_60.md) / [REVIEW_64](../reviews/REVIEW_64.md) | sdk-bridge resume/recovery sequence(3 段:主路径/自愈/收尾,双端镜像, applicationSid stable + cli_session_id update) |
| [sdk-bridge-recovery-decision.puml](sdk-bridge-recovery-decision.puml) | active | commit 627a0c2 + 5b66cd8 / [REVIEW_60](../reviews/REVIEW_60.md) / [REVIEW_64](../reviews/REVIEW_64.md) | sdk-bridge sendMessage 决策树(3 段:主路径/自愈/收尾, applicationSid stable + cli_session_id update) |
| [universal-message-dispatch-flow.puml](universal-message-dispatch-flow.puml) | active | commit d5549c6 / [REVIEW_61](../reviews/REVIEW_61.md) / [REVIEW_64](../reviews/REVIEW_64.md) | 消息派发 sequence(4 段:入队/event+poll hybrid dispatch (50ms debounce + 250ms fallback)/派发/失败处理) |
| [universal-message-dispatch-decision.puml](universal-message-dispatch-decision.puml) | active | commit d5549c6 / [REVIEW_61](../reviews/REVIEW_61.md) / [REVIEW_64](../reviews/REVIEW_64.md) | 消息派发 tick 决策树(4 段:候选/公平兜底/event+poll hybrid dispatch (50ms debounce + 250ms fallback)/失败处理) |
