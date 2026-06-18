# CHANGELOG_294 - Default model chip and branch refresh

## Summary

- Session metadata chips now display Codex and Claude default-model placeholders as `默认`, matching sessions with no explicit model.
- SessionDetail refreshes the current Git branch every 10 seconds while the detail view is open, with stale IPC responses ignored.

## Validation

- `pnpm typecheck`
- `pnpm build`
