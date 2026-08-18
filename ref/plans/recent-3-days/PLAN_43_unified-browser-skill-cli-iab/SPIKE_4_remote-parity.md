# Spike 4: Remote/Server Core browser and attachment parity

## Question

Can the staged CLI route reuse the existing Remote Browser broker and attachment pipeline while the
current MCP browser surface remains a safe fallback?

## Method

- Inspected Server Core browser tool registration, in-memory desktop broker, Desktop long-poll
  executor, source-qualified owner hashing, provider host environments, and Remote composer image
  transfer.
- Ran focused tests through the repository's Electron-ABI test entrypoint:
  `pnpm test -- <five remote/browser/attachment files> --reporter=dot`.
- An initial direct Node Vitest invocation was discarded because it hit the documented
  better-sqlite3 ABI 130/127 mismatch; no binding was rebuilt or changed.

## Observed result

- The canonical run passed 5 files and 24 tests.
- Core already authenticates the caller session before `browser_*` dispatch and carries only bounded
  operation/args through the Desktop broker.
- Desktop qualifies owners with profile, Core id, generation, and session id before using the Local
  browser engine.
- Remote screenshots are sanitized and transferred inline without exposing Desktop paths.
- Remote composer and Server Core attachment storage already carry PNG input through bounded private
  storage.
- Provider environments intentionally exclude broad host secrets and private paths. A CLI socket
  projection must be a new browser-only provider-runtime capability, not an environment leak.

## Conclusion

Keep the existing Remote MCP Browser route operational while adding a CLI adapter that dispatches
the same validated semantic operations into `ServerCoreDesktopBroker.invoke`. Project tab state to
the Desktop renderer using source-qualified session identity; never expose the hashed engine owner.
Remove/disable the fallback only after real Remote CLI, IAB projection, disconnect, generation
retirement, screenshot, and annotation parity pass.

## Remaining risk

- The provider sandbox/OCI boundary needs a private browser shim/socket mount or equivalent fixed
  runtime command capability.
- Remote tab state currently has no renderer projection; add revisioned, source-qualified events and
  snapshots.
- Live Worker disconnect/reconnect and generation replacement require acceptance testing beyond the
  existing unit coverage.
