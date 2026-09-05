const config=require('./vitest.config.cjs');
config.test.include=[
  "src/main/hook-server/server.test.ts",
  "src/main/agent-deck-mcp/__tests__/helpers.deny-external.test.ts",
  "src/main/agent-deck-mcp/__tests__/hand-off-session.resource-transfer.test.ts",
  "src/main/store/__tests__/task-repo.test.ts",
  "src/main/store/__tests__/message-delivery-state.test.ts",
  "src/main/teams/__tests__/universal-message-watcher-durability.test.ts",
  "src/main/session/worktree-transition/__tests__/transition-delivery.test.ts",
  "src/main/session/worktree-transition/__tests__/git-cleanup-references.test.ts",
  "src/main/plan-review/__tests__/service.test.ts",
  "src/main/diff-review/service.test.ts"
];
module.exports=config;
