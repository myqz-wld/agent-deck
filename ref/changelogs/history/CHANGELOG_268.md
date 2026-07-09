# CHANGELOG_268: 总结模型默认提示收敛

## 变更

- 设置页「周期性总结」和「Hand-off 简报」会随 Claude / Deepseek / Codex 来源切换，提示模型名留空时使用的默认模型。
- Claude / Deepseek 来源只说明默认档位：周期性总结默认 `Haiku`，Hand-off 简报默认 `Sonnet`。
- Codex 来源只说明留空时使用 Codex 配置里的默认模型，不展示运行时解析链路或当前填写值。

## 验证

- `pnpm typecheck`
