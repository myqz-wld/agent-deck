# CHANGELOG_221 — 沙盒/权限重启恢复上下文

## 变更类型
行为修复

## 背景
用户反馈切换 Codex sandbox、Claude OS sandbox 或 Claude「不再询问」后，SDK 子进程重启会让模型像丢了历史一样继续，尤其默认发送的「继续之前的会话」容易被模型误解成一条新的用户需求。

## 实现
- 新增共享内部重启 prompt，替换 renderer 和 IPC 里的「继续之前的会话」硬编码。
- 正常 jsonl 存在的 restart resume 路径也注入应用 DB 中的历史摘要和最近原始对话消息，不再只在 jsonl-missing fallback 时补历史。
- restart 历史注入使用「应用内部重启指令」header，避免把重启控制消息标成「用户当前消息」。
- Claude restart close 跳过 recentlyDeleted 黑名单，避免同 sid 恢复后的 SDK 事件在 60 秒窗口内被误丢弃；普通 close/delete 仍保留黑名单保护。

## 验证
- 补充 Claude permission/sandbox restart 单测：jsonl 存在时 createSession prompt 含 DB 历史和内部重启指令，并确认 restart close 不写 recentlyDeleted。
- 补充 Codex sandbox restart 单测：jsonl 存在时 createSession prompt 含 DB 历史和内部重启指令。
