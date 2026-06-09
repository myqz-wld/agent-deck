# CHANGELOG_241

## UI 事件描述与展示文案补强

- TeamDetail「近期事件」不再只显示裸工具名：`tool-use-start` / `tool-use-end`
  复用 ActivityFeed 的工具入参摘要，展示 Bash 命令、文件路径、搜索词等关键上下文。
- TeamDetail 等待态改成用户向描述：权限请求显示「工具 + 入参摘要」，提问/计划/取消态显示明确动作，
  未知结构兜底为「等待响应」。
- ActivityFeed SimpleRow 收紧空值和异常 payload 兜底：缺 `cwd` / `filePath` 时不留下空分隔符，
  `reason` / `message` 为结构对象时不再渲染成 `[object Object]`。
- SessionCard 等待态实时行显示具体等待原因，例如「等待你授权 Bash · pnpm test」；
  缺文件路径的 file change 事件跳过弱摘要，避免占一行空白。
- 活动流展示文案收紧：团队 task 文案改为「新任务 / 任务完成」，工具行按钮从
  「展开 prompt / 展开 diff」改为「查看指令 / 查看改动」，空输出状态改为中文状态。
- 新建会话 / 起新会话解决问题弹窗不再显示 `Agent` / `Adapter` / `prompt` 这类内部词，
  改为「执行器」和「第一条消息」。

## 验证

- `pnpm exec vitest run src/renderer/components/activity-feed/describe.test.ts src/renderer/components/TeamDetail/__tests__/events-payload-describe.test.ts src/renderer/components/activity-feed/format.test.ts`
- `pnpm typecheck`
- `pnpm build`
