# Feishu outbound adapter deployment

One service binds one exact Agent Deck instance, topology, Feishu app, and tenant. It opens an
authenticated outbound Feishu WebSocket plus outbound HTTPS calls and reaches the same authoritative
Core as desktop clients through a second, restricted outbound OpenSSH connection. Its only listener
is a service-owner mode-0600 Unix management socket under `/run`; it has no public callback or Agent
Deck port, direct Core socket, local compute fallback, or Relay offline business queue.

The Feishu process uses `/opt/agent-deck/bin/agent-deck-feishu`. That wrapper resolves a regular-file
`active` digest pointer into `/opt/agent-deck/feishu-runtime/releases/<sha256>`, verifies the complete
root-owned tree and its inner checksums, and executes its bundled Node 22.22.3 plus
`better-sqlite3` 11.10.0. No target-native npm install is required. `core-ssh.json` pins the topology,
instance, hostname, host key file, and one private identity per active owner-equivalent Feishu
credential. The Server maps both `desktop` and `feishu` to the same explicit Remote Owner Product v1
grant; product entry points remain channel-specific.

## Server-local one-click flow

1. First deploy a healthy Relay or Full Server with the repository deployment command. The release
   installs both amd64/arm64 digest descriptors, selects the target architecture, validates the
   native SQLite ABI, creates `agent-deck-feishu`, installs the hardened unit, and publishes a
   `desired` runtime digest. It does not enable the bot before credentials exist. A fresh connection
   selects and verifies `desired`, restoring the previous runtime if connection fails. Established
   connections keep `active` unchanged until the explicit `feishu upgrade` transaction succeeds.
2. In Feishu Developer Console, create/select an enterprise custom app, enable its bot, grant the
   required receive/send/card permissions, use long-connection delivery for
   `im.message.receive_v1` and `card.action.trigger`, publish it, and install it in the tenant. These
   Feishu-owned steps cannot be automated by Agent Deck.
   Message progress reactions additionally use `im:message.reactions:write_only` (or the existing
   `im:message` grant). The bot replaces its own reaction with `Typing` while processing, `OneSecond`
   while awaiting approval, `DONE` after completion, or `CrossMark` on failure. Reaction API failures
   do not block replies. Correlation metadata stays in bounded memory; graceful shutdown removes
   unfinished indicators, while an abrupt process failure can leave an old indicator visible.
3. Copy the matching topology's `server-control.config.example.json` and the Feishu connect request
   from `/opt/agent-deck/share`, replace every binding, and make both files root-owned mode 0600.
   Set `feishuIdentityOwner.uid/gid` to the actual results of
   `id -u agent-deck-feishu` and `id -g agent-deck-feishu`. Put only the app secret value in the
   request's root-owned mode-0600 `appSecretFile`; never put it in JSON, argv, environment, or logs.
4. Check, preview, connect, and verify from the Server administration shell:

   ```bash
   /opt/agent-deck/bin/agent-deck-server feishu check \
     --config /etc/agent-deck/server-control/instance-a.json
   /opt/agent-deck/bin/agent-deck-server feishu dry-run \
     --config /etc/agent-deck/server-control/instance-a.json \
     --request /etc/agent-deck/server-control/feishu-connect.json
   /opt/agent-deck/bin/agent-deck-server feishu connect \
     --config /etc/agent-deck/server-control/instance-a.json \
     --request /etc/agent-deck/server-control/feishu-connect.json
   /opt/agent-deck/bin/agent-deck-server feishu verify \
     --config /etc/agent-deck/server-control/instance-a.json
   ```

   `connect` atomically issues a dedicated restricted SSH credential, installs service-owned mode
   0600 configuration/secrets, enables the service, and waits for both Feishu and restricted Core
   health. Core verification requires the exact Remote Owner Product v1 method set, the exact
   Feishu-internal method set, and a live `access_denied` result for an out-of-policy
   `system.health` request. On failure it disables the unit and compensates the
   authorization/config transaction. A failed enrollment retains its credential id as revoked
   history; retry with a new credential id. This prevents a live Relay that already observed the
   enrollment from losing its authoritative history during rollback.
   An abandoned unpaired gateway credential can also be replaced when no pairing or user metadata
   exists; its local history remains revoked. Existing owner identities require explicit rotation.
   After success, the operator may remove the app-secret input file under the site's secret-retention
   policy; the sidecar has its own protected copy.
5. Generate and approve the first owner binding:

   ```bash
   /opt/agent-deck/bin/agent-deck-server feishu pair create --config /etc/agent-deck/server-control/instance-a.json
   # The intended user sends the returned: /pair <one-time-code> in a p2p chat.
   /opt/agent-deck/bin/agent-deck-server feishu pair list --config /etc/agent-deck/server-control/instance-a.json
   /opt/agent-deck/bin/agent-deck-server feishu pair approve \
     --config /etc/agent-deck/server-control/instance-a.json --request-id <request-id>
   ```

   Codes contain 192 random bits, expire after ten minutes, are single-use, stored only as hashes,
   and may be generated at most once every 30 seconds. Code possession creates only a pending
   candidate; local Server approval is the authority transition.

## Operations and rollback

Relay upgrades repair missing Feishu credential history left by older failed enrollments before
resuming an interrupted instance-manager operation. Recovery copies only public metadata into
revoked authority records; it preserves existing grants, SSH entries, and Relay metadata. The
root-only `feishu recover-authority --config <path> --metadata-file <path>` command exposes the
same bounded repair for administration. Non-Feishu or foreign-instance inconsistencies fail closed.

```bash
/opt/agent-deck/bin/agent-deck-server feishu status --config /etc/agent-deck/server-control/instance-a.json
/opt/agent-deck/bin/agent-deck-server feishu credential rotate \
  --config /etc/agent-deck/server-control/instance-a.json \
  --request /etc/agent-deck/server-control/feishu-credential-rotate.json
/opt/agent-deck/bin/agent-deck-server feishu upgrade --config /etc/agent-deck/server-control/instance-a.json
/opt/agent-deck/bin/agent-deck-server feishu disconnect \
  --config /etc/agent-deck/server-control/instance-a.json \
  --request /etc/agent-deck/server-control/feishu-disconnect.json
```

`upgrade` stops the exact service, checkpoints its private metadata, switches `active` to the
release-installed `desired` digest, restarts, and verifies Feishu plus Core. Activation failure
stops the new service, preserves failed metadata privately, restores the pre-upgrade database and
runtime pointer, and verifies the prior service. Accepted upgrades discard the temporary checkpoint.
Intentional rollback uses the prior Server release and `feishu upgrade` when metadata formats are
compatible; a schema downgrade requires a matching operator-owned state backup. `disconnect` disables the unit, revokes the dedicated Server
credential, removes protected connection files, and deliberately preserves SQLite state for explicit
operator recovery or deletion.

Credential enrollment binds exact `(appId, tenantKey, openId)` subjects to Core credential ids.
Revocation is rechecked for every callback and transport attempt. Approval cards default to 30
minutes; `pendingPresentationLifetimeMs: 0` explicitly makes presentation lifetime indefinite, but
authoritative Core pending state still decides whether an action is valid. SQLite persists only
identity, subscription, cursor, health, and delivery-reconciliation metadata—never message text,
cards, action values, history, diffs, blobs, secrets, paths, or Core frames.

## Delivery and group-chat behavior

In a paired p2p chat, `/settings` manages separate last selections for bot conversations and new
work sessions. The same configuration is available in the connected Core's Desktop settings.
`/models [adapter-id] [provider]` lists live choices. Save a choice with
`/settings chat <adapter-id>` or `/settings session <adapter-id>`, optionally followed by a JSON
object containing `model`, `provider`, `thinking`, and adapter-native mode/sandbox fields:
Claude uses `permissionMode` / `claudeCodeSandbox`, Codex uses `approvalPolicy` / `codexSandbox`,
and Grok uses `sessionMode` / `grokSandbox`. A same-adapter save patches only the specified fields;
switching adapters clears incompatible choices. Null mode/sandbox fields follow live creation defaults.
The Core Workspace ceiling remains enforced. No initial adapter is silently selected, and unavailable
saved choices never fall back. `/models` includes the currently supported native options.

Saved defaults affect new conversations and work sessions. To change a running target, use
`/chat runtime` then `/chat runtime-set <revision> <JSON-patch>` for the assistant, or `/runtime`
then `/runtime-set <revision> <JSON-patch>` for the selected work session. These explicit runtime
edits keep future defaults unchanged.

Ordinary p2p text always goes to the assistant, whose history has a separate persistent binding.
`/new [task]` creates a work session using the saved work selection; `/select <id>` changes the
work target and `/send <text>` sends to that target. These operations preserve assistant history.
`/chat new` explicitly starts fresh assistant history, while `/chat list`, `/chat select <id>`,
and `/chat history` browse and resume earlier assistant conversations. `/sessions` and `/history`
remain scoped to work sessions. Groups do not bootstrap private assistant conversations.

Natural-language work listing uses `list_work_sessions`: it excludes registered assistant chats,
includes dormant work, and preserves the separate collaboration/history permission boundaries.
Existing assistant identities reconcile from gateway metadata when a private conversation resumes.
For owner-requested creation, the assistant uses `create_work_session` with a short task-based
name or the owner's explicit name, keeping its own history and saved chat configuration intact.
Core registers the work before its first reply; Feishu connects replies and selects the committed
work unless a newer owner selection or a subscription-capacity limit prevents that switch.
Creation retries keep the same request identity; an uncertain startup requires reconciliation.

`/rename <name>` renames the selected work session, and `/chat rename <name>` renames the assistant
conversation. The assistant can use `rename_work_session` for an explicit work rename request.
Names persist in Core; work cards put the readable name in their heading and the ID in a footer.
Concurrent renames preserve the newer manual name. Natural-language configuration requests use
`update_feishu_preferences` with the last settings revision and the same adapter-specific rules.

`/create last <directory> -- <message>` offers explicit directory selection. Adapter and optional
`--model`, `--provider`, or `--thinking` flags override and remember the work selection. Existing
sessions retain their native controls. `/unsubscribe` applies to the selected work session;
`/chat unsubscribe` applies to the assistant. Natural-language work creation reads the current
preferences through Core's read-only MCP tool before using the dedicated work tool.

Ordinary assistant replies have no source label: short prose uses text, while Markdown uses an
untitled rich-text post with native lists, code and tables. Local file links display copyable paths.
Work replies use cards identifying the session;
subscribed private `/send` requests omit a redundant receipt that could arrive after the result.
An explicitly unsubscribed target still returns a recovery hint. Assistant conversations use the
owner-requested light catgirl voice, while work prompts and approval details remain task-focused.
Existing assistant history receives one versioned setup update on its next message or selection.
Commands and interactive approvals identify their target. Approval cards show the operation and
parameters with one-time approval or denial. The terminal card is returned in the Feishu callback,
never patched before acknowledgement; already-decided requests cannot execute again. Approval
notifications query only their owning session, so missing unrelated subscriptions cannot block replies. P2p command results are standalone;
group results quote the request. Groups cannot read/change private preferences or use saved choices.

Gateway metadata schema v6 retains independent assistant identity/generation and subscription
purpose, and adds bounded work-registration metadata plus the assistant setup version. Verified
v4/v5 migrations preserve pairing, work selection and delivery state; chat bodies
remain in authoritative Core history. Remote creation commits only canonical provider session IDs.

Core owns a bounded, owner-only, atomically replaced configuration file. Desktop/Feishu saves use
an independent settings revision to detect concurrent edits. Protocol 2.12 requires matching Desktop,
Worker, Server and Feishu artifacts during activation; no credential re-enrollment is required.

Assistant reply delivery preserves the existing metadata-only notification path. Core's `event.persisted` notification carries only an event identity; the gateway
reads that exact history entry before sending text. User messages and thinking are not echoed,
and group chats never fetch assistant bodies. Older entries outside the bounded history lookup
produce an explicit `/history` notice. Ordinary text uses the selected session's existing tools
and permissions.

Feishu's provider UUID guarantee for message create/reply is exactly one hour. The adapter records
that deadline at the first possibly accepted invocation and never extends it after another ambiguous
try. A crash replay may reuse the UUID only before the recorded deadline. At or after the deadline,
the delivery becomes terminal `exhausted` and is not sent again.

For Core notification streams, terminal `exhausted` means “consumed but deliberately skipped.” The
adapter emits the fixed `delivery_exhausted` / `core-notification-skip` audit and observer records,
advances the durable cursor through that Core revision, and continues with the next revision. A
reconciliation-required notification is first fenced to `exhausted` and follows the same rule.
Repeated exhausted reads do not refresh their retention timestamp. Removing old terminal delivery
rows cannot replay their provider work because the independent monotonic Core cursor remains ahead;
pending and reconciling evidence is never pruned.

`/delete` is p2p-only. It reads the authoritative selected session, shows its exact id, title,
archive state, and update revision, then creates a five-minute random confirmation token stored only
as a hash. `/delete-confirm <token>` binds the same tenant/user/chat/session snapshot, sends one
stable idempotency key plus expected state to Core, and clears only that session's local selection
and subscription metadata after the authoritative deletion succeeds. Replays return the completed
result without invoking Core again; group chats never receive a deletion confirmation.

Group chats are intentionally read-restricted. `/sessions`, `/projects`, `/history`, and `/runtime`
return fixed prompts without calling the corresponding sensitive Core read. `/pending` exposes only
an owned request-kind projection with no action buttons or arbitrary Core display fields. Use a full
authenticated client or an owner p2p chat for those details and actions.

## Workspace visibility

Feishu and desktop clients share the same authoritative Workspace ceiling. In an owner p2p chat,
`/directories [cursor]` lists only normalized Workspace-relative directory references and
`/create <adapter-id> <relative-directory> -- <first-message>` creates a session only after Core
re-resolves that existing directory beneath the configured Workspace. `.` selects the Workspace
root. Absolute paths, parent traversal, backslash forms, symlink escapes, Worker-private paths, and
Core-owned `cwd` values are rejected and are never rendered or persisted by the gateway. Group
chats hide directory suggestions entirely.

The release artifacts have been reproduced byte-for-byte for amd64 and arm64. Their pinned Node
22.22.3 runtime, ABI 127, inner checksums, and real bundled SQLite load have also been exercised in
Ubuntu 24.04 and Rocky Linux 9 containers. Production acceptance still requires clean real hosts
with systemd and sshd, pinned-host-key failure, the deployment's egress policy, and credentialed
Feishu readiness/reconnect/send/action/revocation/multi-chat flows. Container validation does not
prove boot-time ownership, forced-command behavior, the live provider's one-hour UUID behavior,
WebSocket redelivery ordering, group-card visibility, or post-crash reconciliation; capture those
with disposable credentials before production acceptance.

Incoming messages older than five minutes are acknowledged and ignored before pairing or Core
execution. Age uses the original message creation time. This does not expire running tasks,
provider reply notifications or the separate validity period of approval cards.
