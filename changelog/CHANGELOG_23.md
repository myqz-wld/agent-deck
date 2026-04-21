# CHANGELOG_23: 新建会话 cwd 缺省回落用户主目录

## 概要

新建会话时不再强制要求填写工作目录 cwd。renderer NewSessionDialog 去掉「必填」校验、placeholder 改为「留空使用主目录 (~)」；main 端 IPC `AdapterCreateSession` handler 与 `cli.ts` 的 `agent-deck new` 同步兜底，cwd 为空时统一回落到 `os.homedir()`。

## 变更内容

### src/renderer/components/NewSessionDialog.tsx
- 标签 `工作目录 cwd *` 去掉 `*` 必填星号
- placeholder 由示例路径改为 `留空使用主目录 (~)`
- 删掉 `if (!cwd.trim()) setError('请填写工作目录 cwd')` 的提交前校验
- 「创建会话」按钮 disabled 条件去掉 `!cwd.trim()`，仅保留 `!prompt.trim()`（首条消息仍必填，因为 SDK 会卡 30s fallback）

### src/main/ipc.ts
- 引入 `node:os` 的 `homedir`
- `AdapterCreateSession` handler 在 `adapter.createSession(o)` 前判断：`o.cwd` 为空字符串 / 仅空白 → 改写为 `homedir()`。renderer 与未来任何 IPC 调用都共用这条兜底，sdk-bridge 收到的 cwd 一定是非空绝对路径

### src/main/cli.ts
- 引入 `node:os` 的 `homedir`
- `parseCliInvocation` 中 `--cwd` 缺省不再抛 `agent-deck new: 缺少 --cwd <path>`，改为 `homedir()` 兜底
- wrapper（resources/bin/agent-deck）依然用 `$PWD` 兜底；这条兜底是给「直接调 .app 二进制 / 第三方调用」的场景

### README.md
- 「应用内新建会话」节：cwd 字段说明补「留空默认用户主目录 `~`」
- 「命令行新建会话」节：`--cwd` 注释改为「缺省 wrapper 取当前 PWD、否则取 ~」；解析失败示例去掉「缺 --cwd」（已不再触发）

## 不在这次改动范围内
- wrapper（resources/bin/agent-deck）的 `$PWD` 兜底逻辑保留不变。终端调用语义照旧（用户期望「在哪个目录跑就在哪个目录建会话」），新的 home 兜底只覆盖「裸调 .app 二进制 / dialog 留空」两条路径
- 「首条消息」仍必填 —— SDK streaming 协议约束，跟 cwd 是两回事
