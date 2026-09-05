# Coordination authentication finding: lead verification

- Finding: `coordination-01`; HIGH; high confidence.
- Baseline: `072dd7a284eebc2752dab7e5d5505aa2ee480b77`.
- Source: `src/main/hook-server/server.ts:61` uses the raw `request.url` prefix to decide whether Hook/MCP authentication runs. Fastify's route matching accepts equivalent encoded and absolute-form request targets.

```ts
this.app.addHook('onRequest', async (request, reply) => {
  if (request.url.startsWith('/hook/')) {
```

## Supported boundary and consequence

The desktop HookServer binds to loopback (`server.ts:211`). A local HTTP client that can connect to that listener but lacks the Hook/MCP secret can skip the token check by using an equivalent noncanonical request target. This is a loopback trust-boundary failure, not proof of an Internet-reachable endpoint.

The lead independently mounted the production `buildHookRoutes` routes with an isolated event collector and injected requests into a fresh non-listening HookServer. For `/hook/userpromptsubmit`, missing authentication returned 401 with zero events. A valid-token control returned 200 with one event. Both an encoded Hook prefix and an absolute-form request target returned 200 without authentication and emitted a production-translated Claude `message` event containing the supplied prompt/session id.

The application connects provider emissions to `sessionManager.ingest(event)` in `src/main/index/bootstrap-infra.ts:185`. The probe verified event emission; it deliberately did not write a live database. The worker is completing the exact persistence/recovery impact trace before final reporting.

## MCP limit

`src/main/agent-deck-mcp/transport-http.ts:66` resolves missing auth to `EXTERNAL_CALLER_SENTINEL`. `types.ts` and `tools/helpers.ts` still deny external callers write tools. Therefore this evidence does not establish unauthenticated MCP spawn/send/shutdown. Read tools permitted to the external caller require separate verification. The raw-path bug and a missing transport-level auth assertion are relevant; the downstream write guard must not be misrepresented as bypassed.

## Evidence and repair direction

- Worker preliminary anchor: `275d9913-2985-4f8a-9daf-48ecf959bd4e` from the recorded coordination session.
- Lead isolated test: `hook-auth-production.test.ts` and its passing log in the invocation's temporary `lead/` evidence directory.
- No listening socket, user database, running app, live session or credential file was used.
- Direction: bind authentication to registered route metadata or route-level hooks, covering every protected route regardless of raw URL representation. Keep malformed-path handling fail-closed and assert authenticated MCP transport input. Add focused canonical/encoded/absolute-form regression cases. No source fix is part of the current scan authorization.
