# CLAUDE.md

> This file is the SSOT for shared repository-level rules in the agent-deck repo. Shared repository rules are governed by this file; the Codex counterpart entry `AGENTS.md` only adds entry-point differences to avoid duplicated and drifting rules.
>
> **In app SDK sessions**, `resources/claude-config/CLAUDE.md` is loaded in addition to this file for Agent Deck protocol conventions.

## Repository Basics

- macOS environment; use pnpm as the package manager.
- Node.js >= 18 (nvm is recommended for management).

## Baseline Directory Structure

When creating or maintaining the repository, place files according to this structure. Unless the project already has a stronger contract, do not create parallel directories for the same kind of file:

- `CLAUDE.md`: shared project SSOT that records repository basics, directory structure, required post-change steps, plan/review lifecycle, review expiry rules, file-size guardrails, project-specific conventions, and validation workflow.
- `AGENTS.md`: entry-point / tool differences only; it references and follows the shared rules in `CLAUDE.md`.
- `UI_COPY_LANGUAGE.md`: language rules for user-visible UI/CLI copy. New or modified user-facing UI/CLI copy must follow it; if the requested copy language or support scope differs from that file, update that file first.
- `README.md`: setup, usage, validation, and structure documentation for users and maintainers.
- `src/`: source code.
- `scripts/`: project scripts and automation helpers.
- `build/`: build artifacts, including `build/dist` packaging output; keep it git-ignored.
- `resources/`: bundled app assets (claude-config / codex-config / plugin / bin).
- `ref/changelogs/INDEX.md`: final changelog index; entry files are `ref/changelogs/CHANGELOG_X.md`.
- `ref/reviews/INDEX.md`: final review index; entry files are `ref/reviews/REVIEW_X.md`.
- `ref/plans/INDEX.md`: final plan index; final plan files live in `ref/plans/`.
- `ref/conventions/INDEX.md`: index of promoted project conventions. Convention bodies use `ref/conventions/<X>-<topic>.md`; `ref/conventions/tally.md` is the entry point for repeated feedback / repeated pitfall counts.
- `ref/flows/`, `ref/architecture/`: PlantUML flow / architecture diagram SSOTs (`.puml` files are committed; rendered artifacts are not).
- `.refs/`: must be added to `.gitignore`; stores only non-final plan/review working copies, not final records.

---

## Required After Changes (Minimum Workflow)

> This section preserves the repository's minimum closed-loop workflow. For `ref/` project artifacts, directly follow the existing INDEX and neighboring-file formats in `ref/changelogs/`, `ref/reviews/`, `ref/conventions/`, `ref/flows/`, and `ref/architecture/`.

1. **When changing user-visible behavior, file structure, or startup behavior** (UI / CLI copy / settings / keyboard shortcuts / project structure / ports / dependencies / validation steps), update the relevant section of `README.md`. When adding or changing user-facing UI/CLI copy, follow `UI_COPY_LANGUAGE.md`; if the language requirement differs, update that file first. Pure bug fixes and internal refactors do not require README changes.
2. For every meaningful feature, behavior, API, or dependency change, write `ref/changelogs/CHANGELOG_X.md` and update `ref/changelogs/INDEX.md`. For debug, performance, security, or review-driven fixes, write `ref/reviews/REVIEW_X.md` and update `ref/reviews/INDEX.md`. Choose `X` as the next integer after the current maximum, confirmed with `ls`; do not guess. INDEX summaries must be <= 80 characters or one short English sentence.
3. Store non-final plans at `<repo>/.refs/plans/<plan-id>.md`; store non-final review drafts at `<repo>/.refs/reviews/<review-id>.md` or in session output. When finalizing, move the final record and clean up working copies: archive plans into `ref/plans/` and update `ref/plans/INDEX.md`; archive reviews into `ref/reviews/REVIEW_X.md` and update `ref/reviews/INDEX.md`.
4. Before changing functionality, read the project's existing conventions, changelogs, and review records. Start from the relevant `ref/*/INDEX.md`, then read the related entries.
5. Before changing long-lived prompt assets, complete inventory, backup, deduplication, counterpart-asset synchronization, and review according to the "Bundled Asset Self-Containment Principle"; required Agent Deck behavior must remain inside bundled assets.

---

## Project-Specific Conventions (Design Checklist)

Repeated design decisions to keep in mind before making changes:

### Authentication And Session Boundaries

- The app **does not read or write** any API key. All SDK calls use local `~/.claude/.credentials.json` (OAuth).
- SDK oneshots used for intermittent summaries set `settingSources: []` to avoid hook loops back into themselves.
- In-app session SDKs set `settingSources: ['user', 'project', 'local']`, equivalent to running `claude` in that cwd.

### Cross-Session Collaboration / MCP Boundaries

- Cross-adapter collaboration uses Agent Deck Universal Team Backend + Agent Deck MCP tools; do not restore the old inbox-based Agent Teams backend.
- Teammate tool calls run under the teammate session's own permission / sandbox boundary; the lead does not approve permissions on its behalf and does not apply the lead's `permissionMode` / allowlist to teammates.
- The Agent Deck MCP server is enabled by default. When `enableAgentDeckMcp` is disabled, newly created SDK sessions do not mount agent-deck MCP tools, and the `mcp_servers.agent-deck` section automatically injected into Codex is removed.
- Claude / Codex app prompt assets must be audited in pairs: `resources/claude-config/CLAUDE.md` <-> `resources/codex-config/CODEX_AGENTS.md`; same-name files in skills directories must also be checked as counterparts. Adapter tool differences may use different wording, but protocol semantics must not drift on only one side.

### Bundled Asset Self-Containment Principle (Important)

Agent Deck internal assets must be self-contained inside the Agent Deck bundle (core design principle): `resources/claude-config/`, `resources/codex-config/`, bundled `agent-deck-plugin` agents/skills, and MCP tool descriptions injected into SDK sessions must be coherent and effective inside the Agent Deck baseline without depending on any extra installation.

The root `README.md`, `CLAUDE.md`, `AGENTS.md`, and `resources/README.md` are also long-lived prompt assets. When modifying them, audit self-containment, trigger conditions, boundaries, and local links by the same principle. The general prompt-asset inventory, backup, deduplication, and review workflow is owned by the maintenance workflow and must not be written into the Agent Deck runtime baseline.

External extensions may only enhance this repository workflow; they must not carry built-in Agent Deck behavior. When splitting out weakly related content, either delete it from bundled assets or keep a self-contained minimal rule. **Do not** replace required behavior with a pointer to an external asset. Agent Deck's own internal agents / skills / resources that ship with the app may reference one another as an internal closed loop, but the referencing asset must still keep the minimum information needed to execute: trigger conditions, boundaries, failure actions, and similar rules.

### Main-Process Module Communication / IPC Boundaries

- Expose module singletons through `setX` / `getX` (for example `getLifecycleScheduler()`); do not directly import instance objects in each handler file under `src/main/ipc/` because that creates cycle / timing problems.
- Cross-process events must go through `event-bus.ts` + `safeSend` with an `isDestroyed` fallback; do not call `webContents.send` directly.
- The `SettingsSet` handler in `src/main/ipc/settings.ts` is the **change-and-apply-immediately** transit point: whenever adding a setting, add its dispatch logic here, or the setting will be editable but ineffective.
- `shared/types.ts` may only use standard-library types; do not import Electron / Node APIs.
- preload `window.api` is the strongly typed facade; use `window.electronIpc.invoke()` as the fallback for dynamic channels.

## Repeated Feedback / Similar Issues -> Promote Convention (Minimum Workflow)

When the user gives corrective / preference feedback, or when a Coding Agent finds a similar engineering issue during review or bug fixing, first record it in `ref/conventions/tally.md`: increment the count of an existing semantically identical entry by 1, or add a new `count: 1` row. After `count >= 3`, run this repository's review workflow and present the evidence, candidate rule, and recommended decision (adopt / reject / keep observing) to the user for confirmation. Then promote it to `ref/conventions/<X>-<topic>.md` and update `ref/conventions/INDEX.md`. Do not promote one-off requests or trivial observations.

---

## Review Expiry And Minimum Re-Review Scope

When preparing the next review, use this section to determine the minimum re-review scope. `ref/reviews/` contains expiring coverage records, not permanent exemptions.

Minimum scope for the next review:

```text
unreviewed files ∪ expired reviewed files ∪ scope_unknown files
```

A file expires when any of the following is true since the most recent REVIEW baseline that covered it:

- Net change >= `min(200 lines, 30% of current LOC)`.
- Number of distinct commits >= 3.
- At least 90 days have passed and the file changed at least once.
- REVIEW frontmatter marks `expired: true`.

When preparing a review, run `bash scripts/file-level-review-expiry.sh` from the repository root. If the script is missing, determine the same conditions manually with `git log`.

---

## File Size Guardrail (500 Lines)

Before committing any source file over 500 LOC, attempt to split it first. Generated code, lockfiles, snapshots, migrations, and fixtures are exempt.

Split priority:

1. Extract module-level pure functions / types / constants.
2. Convert to same-directory submodules while preserving import paths.
3. Use facade + shared context to split classes only after a plan/review.

If a file genuinely cannot be split, record the file and the concrete reason in the related changelog's "do not split" protection list.

---

## Validation Workflow

After changing code:

```bash
pnpm typecheck       # required
pnpm build           # run for large changes
```

After changing main / preload -> **restart dev**:

```bash
# cleanly kill old processes
lsof -ti:47821,5173 2>/dev/null | xargs -r kill -9
pkill -f "electron-vite dev" 2>/dev/null
pkill -f "Electron.app/Contents/MacOS/Electron" 2>/dev/null

# restart from the repository root
pnpm dev
```

After changing renderer -> wait for HMR to push automatically; no restart is needed.

---

## Packaging And Local Install (macOS)

Whenever you want to try the "installed version" or verify that the wrapper can locate the .app, run the full sequence:

```bash
# 0. Kill all old instances (required before overwrite installs; if explicitly asked not to kill, only run packaging)
pkill -f "Agent Deck.app/Contents/MacOS/Agent Deck" 2>/dev/null
pkill -f "Agent Deck Helper" 2>/dev/null

# 1. Build dmg + .app (about 1 minute)
rm -rf build/dist && pnpm dist

# 2. Overwrite-install to /Applications (must rm an existing .app first; cp -R does not clear leftovers)
rm -rf "/Applications/Agent Deck.app"
cp -R "build/dist/mac-arm64/Agent Deck.app" /Applications/

# 3. Ad-hoc re-sign (see the rule checklist below)
codesign --force --deep --sign - "/Applications/Agent Deck.app"

# 4. Clear the quarantine attribute
xattr -dr com.apple.quarantine "/Applications/Agent Deck.app"

# 5. Symlink the wrapper into PATH (one-time)
ln -sf "/Applications/Agent Deck.app/Contents/Resources/bin/agent-deck" /usr/local/bin/agent-deck
```

### Packaging Configuration Rules

- `mac.icon: "resources/icon.png"` must be configured explicitly; `extraResources` must copy `resources/bin` into the .app `bin`.
- Ad-hoc re-signing, killing old processes before overwrite installs, and unpacking SDK / codex native binaries are all required. If any item is missing, fix the configuration first; do not work around it in business logic.
- When the user explicitly asks not to kill, do not delete or overwrite a running `/Applications/Agent Deck.app`. `rm -rf "/Applications/Agent Deck.app"` causes the current instance to lose bundle resources and execution channels. In that scenario, only package into `build/dist`, then wait for the user to quit manually before overwriting, or copy to a temporary bundle and replace through Finder / system-level tooling.
- Before validating the wrapper, always `unset ELECTRON_RUN_AS_NODE`; if the binary behaves like Node or parses `new` as a script, the validation environment is polluted. Do not change the wrapper / packaging config for that.
- Before and after real vitest SQLite tests, protect the better-sqlite3 binding (evidence: CHANGELOG_42). If Electron reports `NODE_MODULE_VERSION 115 vs 130`, clear the npm prebuild cache and binding build directory, then force rebuild:
  ```bash
  rm -f ~/.npm/_prebuilds/*better-sqlite3*
  rm -rf node_modules/.pnpm/better-sqlite3@11.10.0/node_modules/better-sqlite3/build
  zsh -i -l -c "pnpm postinstall"
  ```
  By default, rely on the binding self-check skip guard at the top of task-repo.test.ts. If you truly run the local real test, finish by running the three commands above.

### Validation

```bash
unset ELECTRON_RUN_AS_NODE  # required: prevents the Electron binary from switching into Node masquerade mode (see the rule checklist above)
"/Applications/Agent Deck.app/Contents/Resources/bin/agent-deck" new --cwd "$PWD" --prompt "ping"
# The app opens / an already running instance creates a new session; the wrapper automatically fills cwd and the new subcommand
```
