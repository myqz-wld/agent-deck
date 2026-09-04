# Custom Points

- 2026-09-04, user decision, scope project entry instructions and bundled Agent Deck application
  conventions: “杀死 Agent Deck 进程需要用户允许，不要老是出现这种乱杀进程的情况。” Treat
  the current Agent Deck host runtime as live user-owned state. Require explicit approval in the
  current conversation for the exact target and action before stopping, restarting, replacing, or
  installing over it; a restart requirement is not authorization.
