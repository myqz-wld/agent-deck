# Spike 1: Ambient CLI session identity

## Question

Can `agent-deck-browser` resolve session authority without a model-provided session id and without
depending solely on a secret-like environment variable surviving every provider shell?

## Method

- Inspected the Local Claude, Codex, and Grok process construction paths.
- Inspected Server Core provider environments and the existing MCP caller identity paths.
- Checked only environment variable names in the current in-app Codex shell; no token value was
  printed.
- Created a mode-0700 session directory with a mode-0700 `agent-deck-browser` command shim and a
  mode-0600 Browser lease sentinel.
- Removed `AGENT_DECK_MCP_TOKEN` and invoked the shim through interactive login zsh, non-interactive
  login zsh, and `/bin/sh` with the session bin directory first in PATH.

Commands and artifacts:

- `.ref/plans/browser-skill-cli-iab-20260818/shim-fixture/session-a/`
- `env -u AGENT_DECK_MCP_TOKEN PATH=<session-bin>:$PATH /bin/zsh -ilc ...`
- `env -u AGENT_DECK_MCP_TOKEN PATH=<session-bin>:$PATH /bin/zsh -lc ...`
- `env -u AGENT_DECK_MCP_TOKEN PATH=<session-bin>:$PATH /bin/sh -c ...`

## Observed result

- The current Codex tool shell contains a per-session MCP token name, confirming that Agent Deck
  already has an ambient child-process identity precedent.
- All three shell variants resolved the session shim first and returned the requested operation
  without a session-id argument or MCP token.
- Permissions were `0700` for the session directory and shim and `0600` for context.
- Claude options accept a host-owned environment; Codex uses one per-session app-server client;
  Grok uses a login shell whose post-startup launch string must explicitly preserve/prepend the
  session shim directory.
- Server Core intentionally strips secret-like provider environment values and uses fixed/container
  PATHs, so Remote cannot rely on the Desktop environment technique. Its shim/socket must be mounted
  or installed through the private provider runtime boundary.

## Conclusion

The selected command-shim route is viable and removes model-selected identity. The production shim
must carry only a browser-scoped lease/context and connect to a local-only broker that resolves the
stable application session id. The shared CLI schema must reject any `sessionId` field.

Desktop adapters may use a per-session PATH prefix plus private context. Server Core needs a
provider-runtime-owned shim/socket projection; it must not expose Core private paths or broader MCP
authority to the model.

## Remaining risk

- Run real Local Claude/Codex/Grok acceptance under every supported sandbox mode.
- Validate Windows `.cmd`/named-pipe and Linux Unix-socket forms.
- Add explicit Server Core/OCI contract coverage for the private browser command/socket projection.
- A danger-full-access same-user process can inspect its own browser capability; security comes from
  least privilege, exact owner binding, local transport, lifetime/revocation, and cross-session
  rejection rather than secrecy from the authorized provider process itself.
