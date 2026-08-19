# CLAUDE.md

> Shared repository workflow for the agent-deck repo. Extra engineering or review skills, when present, are enhancement layers.
> Keep shared rules here; the Codex counterpart entry `AGENTS.md` records only entry-point or tool differences.
>
> **In app SDK sessions**, `resources/claude-config/CLAUDE.md` is loaded in addition to this file for Agent Deck protocol conventions.

## Repository Baseline

- macOS environment; use pnpm as the package manager.
- Node.js >= 18.

## Base Directory Structure

Create or maintain files in this structure. Do not create parallel directories for the same file type unless the project already has a stronger project rule.

- `CLAUDE.md`: shared workflow for repository baseline, directory structure, after-change requirements, plan/review lifecycle, review expiry, file-size guardrail, project-specific triggers, archived reference materials, validation, and packaging.
- `AGENTS.md`: Codex entry and tool differences; it references and follows the shared rules in `CLAUDE.md`.
- `UI_COPY_LANGUAGE.md`: SSOT for user-facing UI/CLI copy language and locale mode.
- `README.md`: user and maintainer instructions for setup, usage, validation, and structure.
- `src/`: first-party source code.
- `scripts/`: project scripts and automation helpers, including copied foundation helpers.
- `build/`: the selected generated output root, including `build/dist` packaging output; keep it git-ignored.
- `resources/`: bundled app assets for Claude, Codex, plugins, wrappers, icons, and sounds.
- `ref/changelogs/INDEX.md`: final changelog routing index; final changelogs use `ref/changelogs/<bucket>/CHANGELOG_X_<topic>.md`.
- `ref/reviews/INDEX.md`: final review routing index; final reviews use `ref/reviews/<bucket>/REVIEW_X_<topic>.md`.
- `ref/plans/INDEX.md`: final plan routing index; final plans use `ref/plans/<bucket>/PLAN_X_<topic>.md`.
- `ref/*/{recent-3-days,recent-week,recent-month,history}/INDEX.md`: mutually exclusive time-bucket indexes for final records.
- `.ref/`: add to `.gitignore`; store non-final plans, reviews, raw outputs, spike drafts, scratch notes, and other unarchived LLM-facing material here, never final records.

## Path Privacy

- Treat the repository root as the base for all recorded in-project paths. Use repository-relative paths and never persist a repository/worktree absolute prefix, home-directory path, or username. For known external tools or configuration, use portable environment-variable references such as `$HOME` or `$CODEX_HOME`; otherwise use a non-identifying logical label.

## Required After Changes

Before starting, run `find ref/changelogs ref/plans ref/reviews -maxdepth 2 -type f -name '*.md' 2>/dev/null || true` to see existing records. Missing directories are setup work, not an error. Before creating or moving a final typed `ref/` record, read the relevant root `ref/<type>/INDEX.md` and affected bucket `INDEX.md`. Scan every same-type bucket, choose `X` as the maximum existing same-type number plus 1, and do not guess. Use a short stable kebab-case `<topic>` that is not vague like `update`, `fix`, or `misc`.

1. When user-visible behavior, file structure, startup steps, ports, dependencies, or validation steps change, update the matching `README.md` section. Pure bug fixes and internal refactors do not require README changes.
2. For each meaningful feature, behavior, API, or dependency change, write `ref/changelogs/<bucket>/CHANGELOG_X_<topic>.md`, rebucket all changelogs by `changed_at`, and update the root and affected bucket indexes. For debug, performance, security, or review-driven fixes, do the same under `ref/reviews/` using `REVIEW_X_<topic>.md` and `reviewed_at`. Keep index summaries to 80 characters or one short sentence.
3. Keep non-final plans in the current environment's plan workspace; if no stronger contract exists, use `.ref/plans/<plan-id>.md`. Keep non-final review drafts and raw reviewer output in the current review workspace or `.ref/reviews/`. At final handoff, archive plans into the correct `ref/plans/<bucket>/PLAN_X_<topic>.md`, rebucket by completed date, update the root and affected bucket indexes, and clean up workspace copies.
4. Store durable extra LLM-facing materials, including spike reports, investigation notes, and reusable evidence, somewhere under `ref/` and link them from the relevant final record. Keep temporary scratch, raw logs, and non-final drafts in `.ref/` or the current environment workspace.
5. Keep the advisory `.ref` archive pre-commit hook installed with `bash scripts/ref-archive-reminder-pre-commit.sh --install` after setup or whenever `.git/hooks/pre-commit` is reset. The installer replaces only its managed block and preserves unrelated hook logic. The hook exits 0, but agents must classify each `.ref/` file as durable context to archive, intentionally non-final workspace material to retain, or scratch to remove.
6. Before changing long-lived prompt assets, inventory and back up the confirmed editable files, check paired Claude/Codex assets for semantic drift, and validate local links. Bundled Agent Deck behavior must remain self-contained in `resources/`.

Project-specific triggers:

- After changing main or preload code, restart development after validation. Renderer-only changes use HMR.
- After changing a database schema, add the next migration and advance `user_version` through the normal migration chain.
- After adding an IPC channel, synchronize shared types, main registration, preload facade, and renderer caller.

## UI/CLI Copy Language

Write active project documentation and maintainer/agent-facing instructions in English by default, including changelogs, plans, reviews, and archived reference materials. Exceptions are `UI_COPY_LANGUAGE.md`, user-facing UI/CLI copy governed by that file, locale examples, quoted/source text, and explicit non-English trigger anchors or examples.

Before adding or changing user-facing UI or CLI copy, read `UI_COPY_LANGUAGE.md` and follow its active mode. If the requested copy language or supported locales differ from that file, update `UI_COPY_LANGUAGE.md` first, then make the UI/CLI copy changes.

---

## Project-Specific Conventions

Repeated design decisions to keep in mind before making changes:

### Linux Deployment Automation

When a task deploys or verifies Relay Server, Relay Worker, or Full Server, use
`pnpm deploy:relay-server`, `pnpm deploy:relay-worker`, or `pnpm deploy:full-server`; do not replace
these entrypoints with ad hoc SSH, Podman, or service mutations.

- Start from the matching file under `deploy/examples/`. Keep live configs, SSH identities,
  credentials, and provider auth outside the repository in mode-0600 files.
- Before server `--check`, `--dry-run`, `--deploy`, `--upgrade`, or `--rollback`, fix any confirmed
  source issue, run the required validation, commit the exact release, and push it to the configured
  upstream. The server scripts reject dirty, unpushed, or upstream-diverged releases.
- Run server lifecycle work in this order: `--check`, `--dry-run`, one exact mutation, then
  `--verify`. Use `--rollback` only through the server instance manager's recorded generation.
- Use `--verify` for existing unmanaged instances. Do not silently adopt them; stop and request an
  explicit migration decision or deploy a new managed instance.
- Deploy Relay Server before Relay Worker. Keep the Worker Workspace outside this repository and
  set `credentialFile` to `null` after the first successful configuration and secure transfer-file
  removal. Worker binary rollback requires reinstalling the intended signed Agent Deck app.
- Full requires a separately built digest-pinned appliance image and independently verified egress
  and quota controls. The acceptance booleans record operator attestations; they do not provision
  enforcement.
- Remote Grok Provider supervisor provisioning and its dedicated credential remain optional,
  separately managed lifecycles in both topologies.

The concise command sequence is in `README.md`; topology-specific prerequisites and recovery are in
`deploy/linux/relay/README.snippet.md` and `deploy/linux/full/README.snippet.md`.

### Authentication And Session Boundaries

- The app **does not read or write** any API key. All SDK calls use local `$HOME/.claude/.credentials.json` (OAuth).
- SDK oneshots used for intermittent summaries set `settingSources: []` to avoid hook loops back into themselves.
- In-app session SDKs set `settingSources: ['user', 'project', 'local']`, equivalent to running `claude` in that cwd.

### Cross-Session Collaboration / MCP Boundaries

- Cross-adapter collaboration uses Agent Deck Universal Team Backend and Agent Deck MCP tools as its sole built-in backend.
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

## Review Expiry And Minimum Re-Review Scope

Use this section to determine the minimum scope for the next review. `ref/reviews/` records expiring coverage; it is not a permanent exemption list.

The next review's minimum scope is:

```text
unreviewed files union expired reviewed files union scope_unknown files
```

`scope_unknown files` are files whose previous review coverage cannot be trusted because the review lacks a parseable `review-scope`, lacks a usable `baseline_commit`, or cannot be mapped to the current path.

Since the latest REVIEW `baseline_commit` that covered a file, that file expires when any condition is true:

- Net change is at least `min(200 lines, 30% of current LOC)`.
- At least 3 distinct commits touched the file.
- At least 90 days have passed and the file changed at least once.
- REVIEW frontmatter sets `expired: true`.

Before review, run `bash scripts/file-level-review-expiry.sh` from the repository root. If the script is missing, use `git log` to apply the conditions above manually.

---

## File Size Guardrail (500 Lines)

Before submitting, attempt to split any source file over 500 LOC. Generated code, lockfiles, snapshots, migrations, and fixtures are exempt.

Split in this order:

1. Extract module-level pure functions, types, and constants.
2. Move same-directory submodules behind stable import paths.
3. Split classes through a facade and shared context only after a plan or review.

When a file truly cannot be split, record the path, concrete reason, and revisit trigger in the relevant final record: use the changelog's "Do Not Split Protection" for feature, behavior, API, or dependency changes, or the review's "Residual Risk" for debug, performance, security, or review-driven work.

---

## Validation Workflow

After changing code:

```bash
pnpm typecheck       # required
pnpm test            # required for behavior or structural changes
pnpm build           # required for large changes
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

Whenever you want to try the installed version or verify that the wrapper can locate the `.app`, run:

```bash
pnpm install:local:mac
```

The command packages and checks the app before stopping existing instances. It installs through
hidden staging and backup bundles, rolls back the previous app when installation validation fails,
reuses an already-correct CLI symlink, and validates the installed signature and build metadata.
After success it removes `build/dist/mac-*/Agent Deck.app` so macOS indexes only the installed app;
the DMG and block map remain in `build/dist`.

### Packaging Configuration Rules

- `mac.icon: "resources/icon.png"` must be configured explicitly; `extraResources` must copy `resources/bin` into the .app `bin`.
- Packaging scripts must generate `build/build-info.json` before `electron-builder` and ship it as bundled `build-info.json`. The metadata must include package/app name, semantic version when available, full git commit, short commit, branch when available, dirty flag when determinable, and build timestamp.
- Installed wrappers must expose human-readable version/status output and a machine-checkable freshness check (`agent-deck --version` and `agent-deck --check-installed`). The freshness check compares installed metadata with the current source checkout commit, may compare local `origin/main`, must not fetch remotes, and must report missing metadata separately from a commit mismatch.
- Ad-hoc re-signing, killing old processes before overwrite installs, and unpacking SDK / Codex native binaries are all required. If any item is missing, fix the configuration first; do not work around it in business logic.
- When the user explicitly asks not to kill, run `pnpm dist:mac` only. Do not run `pnpm install:local:mac`, delete the installed bundle, or overwrite a running `/Applications/Agent Deck.app`; wait for the user to quit before installing.
- Before validating the wrapper, always `unset ELECTRON_RUN_AS_NODE`; if the binary behaves like Node or parses `new` as a script, the validation environment is polluted. Do not change the wrapper / packaging config for that.
- Before and after real vitest SQLite tests, protect the better-sqlite3 binding (evidence: CHANGELOG_42). If Electron reports `NODE_MODULE_VERSION 115 vs 130`, clear the npm prebuild cache and binding build directory, then force rebuild:
  ```bash
  rm -f "$HOME"/.npm/_prebuilds/*better-sqlite3*
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
