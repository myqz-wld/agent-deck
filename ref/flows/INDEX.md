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
| [universal-message-dispatch-flow.puml](universal-message-dispatch-flow.puml) | active | commit d5549c6 / [REVIEW_61](../reviews/REVIEW_61.md) / [REVIEW_64](../reviews/REVIEW_64.md) / [REVIEW_112](../reviews/REVIEW_112.md) | 消息派发 sequence(入队/event+poll/派发/stop 边界/post-submit 标记失败处理) |
| [universal-message-dispatch-decision.puml](universal-message-dispatch-decision.puml) | active | commit d5549c6 / [REVIEW_61](../reviews/REVIEW_61.md) / [REVIEW_64](../reviews/REVIEW_64.md) | 消息派发 tick 决策树(4 段:候选/公平兜底/event+poll hybrid dispatch (50ms debounce + 250ms fallback)/失败处理) |
| [issue-tracker-flow.puml](issue-tracker-flow.puml) | active | [issue-tracker-mcp-20260529](../plans/issue-tracker-mcp-20260529.md) / [CHANGELOG_189](../changelogs/CHANGELOG_189.md) | issue-tracker agent 写路径 sequence(report 创建/append source-bound/update_issue_status 源-解决会话改 status/GC 双轨硬删 + event→UI) |
| [issue-tracker-append-decision.puml](issue-tracker-append-decision.puml) | active | [issue-tracker-mcp-20260529](../plans/issue-tracker-mcp-20260529.md) / [CHANGELOG_189](../changelogs/CHANGELOG_189.md) | append_issue_context 4 道守门决策树(not-found/source-bound/resolved/软删 reject; resolved 翻回经 update_issue_status 或 UI) |
| [runtime-logging-flow.puml](runtime-logging-flow.puml) | active | [runtime-logging-electron-log-20260529](../plans/runtime-logging-electron-log-20260529.md) / deep-review-and-asset-polish-20260530 Phase F | runtime-logging console 接管 + 落盘 sequence(init/main 直写/renderer IPC bridge/fatal exit/preload fatal) |
| [summary-handoff-provider-flow.puml](summary-handoff-provider-flow.puml) | active | [CHANGELOG_230](../changelogs/CHANGELOG_230.md) / deepseek-summary-handoff-sdk-prompt-20260608 | summary / hand-off provider 分流(Claude / Deepseek / Codex oneshot) |
| [token-rate-live-flow.puml](token-rate-live-flow.puml) | active | [CHANGELOG_212](../changelogs/CHANGELOG_212.md) | Claude 流式 tok/s 估算 tick sequence(stream_event→eventBus→IPC→renderer; turn 末精确校准) |
