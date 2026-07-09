# CHANGELOG_222 — reviewer 模型名文案泛化

## 变更类型
文档 / prompt asset 维护

## 背景
reviewer 配对说明在 README、应用约定、review skill 和 reviewer agent body 中写死了具体模型版本。该信息会随上游模型升级变化，长期 prompt 资产不应把设计约束绑定到某个具体型号。

## 实现
- 将非 `ref/` 下 reviewer 设计文案中的具体型号改为 Claude adapter / Codex adapter 或 Claude 系模型 / Codex/OpenAI 系模型。
- 保留 agent frontmatter 的 `model:` 运行配置，不在描述正文里重复具体型号。
- 清理源码注释里的非功能性具体模型示例，改为 provider 可用模型、Claude 侧或 Codex reasoning 等稳定描述。
- 保留 model formatter / normalization 和 model passthrough 测试里的具体 model 字符串，避免破坏解析样例覆盖。

## 验证
- `rg` 检查非 `ref/` 目录下的 `Opus 4.7` / `gpt-5.5` / 其他版本化模型名，仅剩 formatter、frontmatter 和测试用途命中。
- `pnpm typecheck`
