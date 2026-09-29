---
review_id: 297
reviewed_at: 2026-09-29
baseline_commit: 760faa9ce9a0db7b0353940fe1652b57d41d32cb
expired: false
---

# Feishu long-connection verification token

## Scope and method

Live acceptance diagnosis, local failure reproduction, complete changed-scope inspection and
official-SDK regressions. No independent agents or paired review were requested.

```review-scope
src/gateways/feishu/mapper.ts
src/gateways/feishu/mapper-transport.test.ts
src/gateways/feishu/message-semantics.test.ts
```

## Finding and fix

HIGH: The shared message/card mapper required a nonempty webhook verification token even though
app-authenticated long-connection events can contain an empty string. Such events failed before
pairing or normal command handling, producing no business response. The token was never used as
an authentication decision by this outbound-only adapter.

Allow exactly the empty string while retaining the required field, type/size/control-character
validation for other values, exact app/tenant binding, sender identity checks, unknown-field
rejection and card nonce validation. Authentication remains owned by the official app connection
and the existing owner-equivalent pairing contract.

The pinned SDK dispatches long-connection events with `needCheck: false`. First-hand payloads in
the [official Go SDK repository](https://github.com/larksuite/oapi-sdk-go/issues/195) independently
show empty header tokens; that report's separate message-loss claim is not adopted here.

## Validation and evidence

- The new direct-mapper and official-SDK/real-gateway regressions failed before the repair: empty
  token rejection and no outbound help response. Both passed afterward.
- Forty-three focused tests passed, covering message/card acceptance, malformed or missing token
  fields, foreign bindings and existing pairing behavior. All modified modules remain below 500 lines.
- Typecheck passed. Full suite: 6,646 passed, three existing skips across two files; 1,074 files passed.
  The shared Electron SQLite binding hash was unchanged.
- Linux headless build and reproducibility, both pinned Feishu runtime builds, headless packaging,
  deployment automation and all topology/manager static gates passed. A packaging check attempted
  before runtime artifacts existed was rerun successfully after the builds completed.
- Actual runtime archive inspection covered 37 members and 26 regular files per architecture,
  root archive ownership, safe member paths and current private identifier/secret exclusion. Source
  and eleven generated Node bundles also passed privacy inspection.
- A local probe used the actual built SDK and mapper with an encoded/decoded synthetic WebSocket
  frame and 64-bit sequence ids. Mapping and the 200 acknowledgement passed without SDK errors;
  the temporary generated module was removed.
- Review-expiry helper exited 1 for existing global/legacy coverage. The complete scope above was
  inspected directly without treating historical records as exemptions.

## Live state and remaining acceptance

The bot's message and card callbacks are saved with long-connection delivery. Version 1.0.0 is
published to the single confirmed owner, with external group/p2p sharing disabled. Service,
WebSocket and restricted Core health passed; no owner is paired yet.

The first real help attempts produced `invalid_event` followed by a redacted SDK error. Empty-token
incompatibility is reproduced locally, but the exact live field rejection and accompanying SDK
error still require actual-event comparison or post-upgrade acceptance. Do not infer successful
business delivery from transport health. Preserve private operational evidence and the active plan
until owner pairing, commands, provider replies and card interaction are verified.

Official server check, dry-run, upgrade and verify passed for `feb434db965a`; official Feishu
upgrade and verify then passed. The active and desired runtime digest match the inspected artifact,
with service, WebSocket and Core connected and no update remaining. Worker verification passed.
No Desktop replacement or credential re-enrollment occurred. One private one-time owner pairing
command has been prepared for the user; approval and real business acceptance remain pending.

The concurrent main-checkout source and review-index edits remain untouched. This repair and its
evidence are retained on the dedicated branch until integration can preserve that ongoing work.
