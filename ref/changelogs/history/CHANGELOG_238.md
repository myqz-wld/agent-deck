# CHANGELOG_238: Codex 新建会话沙盒档位 upsert 同步

## 概要

修复 Codex 侧新建会话显式选择「完全开放」后，进入会话详情仍显示「工作目录可写」
的问题。运行时 `thread/start` 已按 `danger-full-access` 传给 Codex app-server，
缺口在 Agent Deck 写入 `sessions.codex_sandbox` 后没有推送新的 `session-upserted`，
renderer 仍拿着 `session-start` 时的空字段并按前端兜底显示成 `workspace-write`。

## 变更内容

- `persistSessionFields()` 在完成 `codexSandbox` / model / network / directories
  等 per-session 字段持久化后，重新读取最新 session row 并 emit `session-upserted`。
- 新增 `session-finalize.test.ts`，覆盖 `danger-full-access` 写库后会把最新 row 推给
  renderer；session row 已消失时不 emit。
- 本地 app-server 探针确认 Codex 0.138 的 top-level `sandbox: "danger-full-access"`
  会覆盖 config 默认，实际返回 `sandbox.type="dangerFullAccess"`；本修复只补 UI/store 同步。

## 验证

- `pnpm exec vitest run src/main/adapters/codex-cli/sdk-bridge/__tests__/session-finalize.test.ts src/main/adapters/codex-cli/__tests__/teammate-spawn-defaults.test.ts src/main/adapters/codex-cli/sdk-bridge/__tests__/thread-options-builder.test.ts`
- `pnpm typecheck`
- `git diff --check`
