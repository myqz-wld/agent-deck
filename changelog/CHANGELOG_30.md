# CHANGELOG_30: ComposerSdk 拦截 slash 命令，给本地提示

## 概要

agent-deck 的 SDK 通道走 streaming input mode，不带 CLI 的 slash command 注册表，用户输入 `/clear` `/compact` `/cost` 等会撞 SDK 抛的 `Unknown slash command` / `only prompt commands are supported in streaming mode`（视命令而异）。在 `ComposerSdk.send()` 入口加一道守卫，发现 trim 后以 `/` 开头时不发 IPC，本地用 `setSendError` 红条提示「应用内会话不支持斜杠命令，请回终端运行 `claude`」。

## 变更内容

### src/renderer/components/SessionDetail.tsx
- `ComposerSdk.send()` 在 `if (!t || busy) return;` 之后、`setText('')` 之前，加 `t.startsWith('/')` 拦截
- 命中时 `setSendError` 给本地提示，`return` 不进 busy 状态、不发 IPC、不清空输入框（让用户能改成普通文本继续发）
- 复用现有 sendError 红条 UI，不引入新组件 / 新依赖

## 不做的事

- 不本地实现 `/clear` `/compact` `/cost` 等命令的等价语义（之前 plan 里的 B 方案，用户决定算了）；如果以后想做再独立立项
- 不做 slash 命令白名单（区分「拦截」和「放行」）；统一全部拦截，避免与 SDK 内部 slash 注册表的演进出现漂移
- 不动 README（错误提示友好化，不是用户感知层面的功能新增）
