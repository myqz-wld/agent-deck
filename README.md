# Agent Deck

A universal cockpit for Coding Agents. It is a translucent frosted-glass floating window that aggregates multiple Claude Code, Deepseek (Claude Code), and Codex CLI sessions, showing activity, file-change diffs, and periodic summaries in real time. When any session hands control back to you, Agent Deck immediately alerts you with color, sound, and a system notification.

It is built for people who "drive multiple coding agents at once": if you have 3 Claude Code sessions and 1 Codex session running, you no longer need to switch terminal windows one by one to see who is waiting. The window floats in the corner of the desktop, and a red flashing badge plus an alert sound tells you which session stopped.

> Built with Electron + React 19 + TypeScript + Vite + Tailwind 4 + better-sqlite3.

---

## Main Capabilities

- **Translucent frosted-glass floating window**: draggable, resizable, collapsible into a capsule; in pin mode the window is nearly transparent and stays on top so you can keep working through it.
- **Multi-session aggregation**: sessions created inside the app via SDK (**internal**) and events reported from external terminal CLI hooks (**external**) share one view, with three tabs: Live / Pending / History.
- **Persistent session pinning**: pin important sessions from a Live card or detail header. Pinned sessions sort first, a dormant session is reactivated when pinned, and idle lifecycle decay plus retention cleanup skip pinned rows. Deliberate archive, handoff, shutdown, delete, or a real provider session end still proceeds and clears the pin.
- **Activity stream + Diff + Summary**: open each session to inspect its message timeline, Monaco DiffEditor grouped by file, and one-line periodic LLM summaries. Session cards and detail headers show the current model and thinking level; SessionDetail also shows the current Git branch when the cwd is inside a repository. Click a tool-call start row to expand full input, and click an end row to expand output. Task / Agent tool calls have dedicated rendering (subagent name + purple chip + folded/expanded full prompt).
- **Bounded history search**: History searches session directories, titles, messages, thinking, event fields, summaries, and tool output with uniform ASCII case-insensitive matching. Event and summary substring search uses trigram indexes. Tool output longer than 4,096 characters indexes only its first and last 2,048 characters, so text appearing solely in the middle of a long output is intentionally not searchable.
- **Staged local-storage compaction**: large event-search and file-snapshot data migrates in resumable post-startup slices, verifies across an app restart, and retires compatibility storage only at a clean drained shutdown. No automatic `VACUUM` runs, so released pages are reused by SQLite and the physical database file is not expected to shrink immediately. After this v41 cutover completes, downgrading to an older Agent Deck build is unsupported; recovery requires a verified pre-upgrade database backup restored while Agent Deck is stopped.
- **Control handoff alerts**: waiting -> red flashing + alert sound + system notification + Dock bounce; finished -> yellow + completion sound. Each can be disabled independently, and custom alert sounds are supported.
- **Embedded human responses** (SDK sessions only): tool permission requests, Claude proactive questions (options / other / notes), Claude Plan mode execution-plan approval, and MCP user-presentation requests (`present_plan` plans and `present_diff` diffs) are all handled directly in activity-stream cards. `present_plan` blocks indefinitely by default. Its Deep Review view expands the full selectable plan, turns right-clicked selections (or Cmd/Ctrl+Enter) into rendered quote cards above a clean question composer, and uses one isolated same-adapter native fork for read-mostly answers. Final actions live in a bottom decision tray: feedback can be written manually or generated from inherited chat context as an editable LLM draft, and the draft is submitted only after the user explicitly chooses Continue Modifying. An explicit timeout stops the calling flow while the pending card remains available for a later decision that resumes the current owning session (the latest committed handoff successor, when present). Diff presentation supports PR-style two-column before/after view and merge-conflict ours/theirs/resolution view; diff content is collapsed by default and opens into a taller scrollable review area. `present_diff` can keep rationale / confirmation instructions outside the source panes and render optional line-anchored annotation cards beside the presented fragment. When approving Claude Plan mode, you can choose the target permission mode (default / auto-accept edits / keep Plan / fully bypass prompts); switching to "fully bypass prompts" automatically restarts the SDK child process.
- **OS-level sandbox**: Claude Code / Deepseek (Claude Code) SDK child processes can use `workspace-write` or `strict` isolation (macOS Seatbelt / Linux bubblewrap). cwd is writable, sensitive directories such as `~/.ssh` are unreadable, and network is denied by default. When a model wants network access, the `SandboxNetworkAccess` tool loop catches it and prompts the user to retry with `dangerouslyDisableSandbox: true`; the user sees only one final approval dialog. This is aligned with Codex child-process `workspace-write` isolation. Claude has a three-part control surface: (1) global default in Settings, defaulting to workspace-write; (2) new-session override in NewSessionDialog with four choices, "follow settings / off / workspace-write / strict"; (3) runtime switching inside a session from the dropdown above the SessionDetail input, where `off` asks for confirmation and `workspace-write` / `strict` apply through a 5-10s cold SDK restart. Codex has its own Workspace Write / Read Only / Danger Full Access selector; runtime changes are persisted immediately and apply from the next Codex turn without restarting the current turn.
- **Universal Team Backend**: cross-adapter (`claude-code` / `deepseek-claude-code` / `codex-cli`) sessions deliver cross-adapter team messages through DB envelopes + universal-message-watcher. `mcp__agent-deck__spawn_session(team_name)` adds both the lead and teammates to the named team; the Team tab can manually add existing active sessions to an existing team; `mcp__agent-deck__send_message` uses the DB queue and automatically injects replies into the lead conversation. Session detail includes a Tasks tab after Activity, showing the selected session's visible unfinished tasks with an Issues-style toggle for completed tasks. **Messages can be sent without a shared team**: when caller and target have no shared active team, `send_message` automatically falls back to a teamless DM (the message is still injected into the target session, but it does not appear in the team aggregate panel). **Inbox-only teams created inside the CLI are not visible in the agent-deck UI**; use `mcp__agent-deck__spawn_session` to create teams in the universal backend.
- **Native provider-context forks**: `spawn_session(contextMode: "fork")` can create a same-adapter, same-realpath-cwd parallel child from the authenticated Claude, Deepseek, or Codex caller. It includes prior provider history and the current user request while excluding the caller's unfinished assistant/tool frame. Fresh spawning remains the default and the low-context alternative.
- **Per-session model controls and unified Continuation Context**: every in-app new-session surface accepts a free-text model id and an adapter-aware Thinking dropdown. Editing an active SDK session's model or Thinking level automatically saves the selection for subsequent turns without interrupting the current reply. UI hand-off, MCP `hand_off_session`, and missing-provider-history recovery share one provider-neutral Continuation Context engine. It captures an immutable SQLite event-revision snapshot, folds a canonical evidence-backed checkpoint, retains a token-bounded tail of eligible user inputs, and renders the authoritative continuation instruction without recursively nesting older generated capsules. A background service maintains bounded checkpoints at exact persisted revision boundaries: normal refresh waits for the configured interval, enough new normalized evidence, provider idle, and a quiet window; a large-backlog safety refresh can run while the provider is active without interrupting its turn. Background generator calls use the configured cross-session concurrency limit, while foreground hand-off / recovery cancels and awaits same-session background work. Checkpoint generation can degrade honestly through prior-checkpoint, raw-only, and instruction-only modes. The full provider prompt remains private to main; persisted successor history stores the instruction and continuation lineage. A committed handoff also preserves logical ownership across tasks, teams, worktree state, in-flight messages, existing issue authority, pending plan gates, and related-session trajectory reads.
- **Input image attachments**: the main session input and the new-session dialog support paste / drag-drop / upload-button image sending (PNG / JPEG / GIF / WebP, <= 20MB per image / <= 30MB total attachments per message). Claude SDK uses base64 image content blocks; Codex SDK receives `local_image` file paths. The main process writes base64 uploads to `<userData>/image-uploads/<uuid>.<ext>` for downstream use. The history detail view shows what images you sent, and a 14-day orphan-file reaper cleans them up automatically.
- **Model token statistics**: the top bar center shows real-time "output tokens/s" for today's top 3 most-used models over a recent 60-second sliding window; when the window is too narrow it degrades by hiding down to Top1 and then hiding entirely. The Data tab, alongside Live / Pending / History / Team / Issues, shows each model's daily token use: a live all-model token/s area, today's summary with a short Claude Code vs Codex accounting note directly below it, a model x date table (input / output / reasoning / cache read / cache write), and the current quota window, weekly usage, and reset time for Claude / Codex accounts. The note focuses on inclusion rules: Claude total input is input + cache read + cache write, Codex cache read is already part of input, and any displayed reasoning value is already included in output. At app startup, local token details are prefetched and provider quota snapshots are loaded into the renderer store; the app keeps those provider quota snapshots refreshed every 10 minutes even when the Data tab is not open. Open Claude / Codex sessions are reused first; when no live session exists, an independent silent quota probe starts with the app's private directory, without loading Claude hook settings, creating an Agent Deck session, or sending user messages / model turns. The Codex quota probe reuses a short-lived background app-server client across refreshes instead of starting a new process for each read. If the provider requires interactive auth, the probe fails and returns. Deepseek currently shows unsupported because it uses the API channel. Token usage is collected from each assistant message (Claude / Deepseek) / completed turn (Codex); Deepseek Claude-family alias labels are rewritten to the configured Deepseek model ids before aggregation. Variants of the same base model (thinking / 1m and similar) are merged by friendly name. When no model is specified explicitly, Claude / Codex default-model placeholders are displayed.
- **Stable custom model identity**: model normalization removes only recognized terminal accounting variants such as thinking / effort / 1m markers. Semantic provider suffixes stay part of the model id, so a custom id such as `gpt-5.6-sol` remains `gpt-5.6-sol` instead of being folded into `gpt-5.6`.
- **Command-line entry**: `agent-deck new --cwd ... --prompt ...` starts a new session from any terminal.
- **Bundled app-level conventions + skill / agent injection**: every in-app SDK session automatically appends bundled CLAUDE.md / CODEX_AGENTS.md to the system prompt. Bundled prompt / agent / skill resources are self-contained inside the app bundle; user-defined agents/skills are an enhancement layer. Agent Deck can inject its bundled review skills plus heterogeneous reviewer slots: `reviewer-claude` (Claude Code), `reviewer-codex` (Codex SDK), and `reviewer-deepseek` (Deepseek v4-pro). Both skills use exactly two confirmed slots per run: `simple-review` performs one review and one rebuttal before returning the decision to the user, while `deep-review` iterates autonomously and pauses for user review only when remediation requires a major design decision.
- **Multiple adapters**: Claude Code (hook + SDK channels, with SDK streaming input for multi-turn interaction) + Deepseek (Claude Code protocol-adapter channel, independent `~/.agent-deck/.deepseek/settings.json` for URL / token / model while reusing Claude-side agents/skills/CLAUDE.md) + Codex CLI (hook + app-server SDK channels, turn-based protocol that waits for each turn to finish; during an active normal turn, mid-turn steering can inject user corrections into the current turn; Codex reasoning summaries appear in the activity stream, but raw reasoning content is not shown. Codex is often used as a reviewer / subtask teammate; choose it for lead sessions according to personal preference).

---

## Core Concepts

### Session Source: Internal vs External

Each session corresponds to one coding-agent run under one cwd.

- **Internal (SDK channel)**: created from the plus dialog or `agent-deck new`; the app starts the CLI child process through the SDK. Events are marked `source: 'sdk'`; tool calls can be intercepted, sessions can be interrupted, and sessions can be resumed.
- **External (Hook channel)**: run `claude` / `codex` directly in a terminal; installed hooks POST events to the embedded HTTP server (default `127.0.0.1:47821`, Bearer-token auth). Events are marked `source: 'hook'`; they are read-only and cannot be controlled from the app.

SDK-owned sessionIds are added to `sdkOwned`, and hook-channel events with the same id are dropped to avoid duplicate display.

### Lifecycle And Archive (Orthogonal)

`lifecycle` and `archived_at` are two independent dimensions.

| State | When It Is Entered |
|---|---|
| `active` | Default; has events within the recent active window (default 60 min) |
| `dormant` | No events beyond the active window; SDK-channel `session-end` also lands here: the stream has stopped, but historical jsonl still exists and can be resumed |
| `closed` | Hook-channel `session-end` (terminal CLI truly exits) or dormant beyond the closed threshold (default 24 h) |
| `archived_at IS NOT NULL` | User manually archived it; completely independent of lifecycle, and unarchiving preserves the original lifecycle |

If a closed session receives another event with the same sessionId, it is automatically revived to active. Archived sessions skip lifecycle advancement and do not participate in time decay.

`pinned_at` is a persistent Live-session protection flag. The idle scheduler and history retention GC recheck it atomically at the final write/delete boundary, so a pin that arrives after candidate selection still wins. Pinning a dormant row moves it back to active; deliberate terminal actions clear the pin instead of blocking the requested workflow.

### Control-Handoff Detection

Each event is translated into session activity, which determines card color and whether an alert fires:

| activity | Color | Alert |
|---|---|---|
| idle | Gray | - |
| working | Green pulse | - |
| waiting | Red flashing | Alert sound + system notification + Dock bounce |
| finished | Yellow | Completion sound (light) |

There is no full-window flashing because it is too distracting; animated status badges + sound + system notifications are enough.

### Adapter Architecture

The `AgentAdapter` interface declares `capabilities`, and the UI hides unsupported fields based on capability.

- **Claude Code**: hook + SDK channels, with all capabilities enabled (create / interrupt / send message / tool approval / AskUserQuestion / ExitPlanMode / switch permission mode / install hook).
- **Deepseek (Claude Code)**: reuses the Claude Code SDK bridge and Claude-side agents/skills/CLAUDE.md; only auth and model env are overridden from `~/.agent-deck/.deepseek/settings.json`; no independent hook is installed.
- **Codex CLI**: app-server SDK channel plus external terminal hook channel. SDK sessions support create / send message / interrupt / resume / active-turn correction; external terminal sessions are read-only hook records installed through `~/.codex/hooks.json` or `<cwd>/.codex/hooks.json`. Codex terminal permission hooks are shown as waiting states, but approval still happens in the terminal because the hook channel cannot answer on Codex's behalf. Normal SDK messages are still turn-based and wait for the previous turn to finish. The Codex adapter's `sendMessage` automatically uses `turn/steer` when the current normal turn is busy; otherwise it queues a message for the next turn. The same input box switches to "correction" mode based on state.

To add an adapter, implement and register the `AgentAdapter` interface.

### Diff Rendering

`DiffRegistry` + `DiffRendererPlugin` interface. Built-ins: text (uses Monaco DiffEditor when before/after snapshots exist; whole-file additions and deletions render as full green/red panels; when Codex or old records only provide unified diff, it reconstructs before/after snippets and reuses the same Monaco DiffEditor or the same whole-file panels; only binary/rename patches that cannot be parsed are shown as raw text; the Changes page's "final diff" is based on file before/after snapshots captured in session records, preserves initial create / final delete as whole-file additions / deletions, and no longer reads the current Git worktree; when historical records lack snapshots, it falls back to recorded patches; the Changes tab can enlarge the current diff and move to the previous/next changed file) / image (side-by-side / after-only / slider comparison views) / pdf (placeholder). Register new renderers in `src/renderer/components/diff/install.ts`.

MCP image tools are integrated by the `mcp__<server>__Image{Read,Write,Edit,MultiEdit}` naming convention. Image binaries do not cross IPC; the renderer requests dataURLs from the main process through `loadImageBlob` on demand, with allowlist + size checks.

### Intermittent LLM Summaries

The scheduler scans active+dormant sessions every few minutes and triggers by elapsed time or event count. It has three fallback layers: run one low-cost LLM oneshot with the provider selected in settings -> use the latest assistant text -> use event-kind statistics. The LLM writes a one-sentence description of "what the session is currently doing", shown on the second line of cards and in the SessionDetail Summary tab.

### Bundled Prompt Assets

In-app SDK sessions load Agent Deck's packaged app conventions, reviewer agents, and review skills. These bundled resources are the runtime baseline. User-defined agents/skills can only enhance them; they cannot replace cross-session protocol, reviewer discipline, or MCP boundaries.

- Claude Code / Deepseek resources are in `resources/claude-config/`; Codex resources are in `resources/codex-config/`.
- Same-name skills, reviewer agents, and app environment conventions are maintained as Claude/Codex counterparts. Protocol semantics must remain consistent; tool names, turn boundaries, and sandbox details are adapter-specific.
- Resource paths, packaging locations, and injection methods are defined in [resources/README.md](resources/README.md).

---

## Installation And Use

### Platform Support Matrix

| Platform | Status | Notes |
|---|---|---|
| **macOS 12+ (Apple Silicon / Intel)** | **GA** | Primary development and test platform; frosted-glass vibrancy / Dock bounce / Notification Center are all available |
| **Windows 10 1703+ / 11** | **beta** | NSIS installer + portable targets; wrapper uses `agent-deck.cmd`; no vibrancy (`titleBarStyle: hidden + frame: false` is supported on Win, but without frosted glass); no Dock bounce, so it relies on system notifications + sound. Real-device Win E2E is left for CI validation |
| **Linux** | dev only | `pnpm dev` works; `dist:linux` has an AppImage target configured but is not separately validated; the `paplay -> aplay` sound fallback chain is fragile on desktops without PulseAudio |

### macOS: Install dmg

```bash
# 0. Close old instances (required before overwrite installs; if explicitly asked not to kill, only run packaging)
pkill -f "Agent Deck.app/Contents/MacOS/Agent Deck" 2>/dev/null
pkill -f "Agent Deck Helper" 2>/dev/null

# 1. Build dmg + .app
rm -rf build/dist && pnpm dist:mac

# 2. Install to /Applications
rm -rf "/Applications/Agent Deck.app"
cp -R "build/dist/mac-arm64/Agent Deck.app" /Applications/

# 3. Ad-hoc re-sign (so the signing Identifier matches com.agentdeck.app) + clear quarantine
codesign --force --deep --sign - "/Applications/Agent Deck.app"
xattr -dr com.apple.quarantine "/Applications/Agent Deck.app"

# 4. Symlink the CLI wrapper (optional, lets any terminal directory run agent-deck ...)
ln -sf "/Applications/Agent Deck.app/Contents/Resources/bin/agent-deck" /usr/local/bin/agent-deck
```

See "Development Guide -> Packaging Rules" for the rules behind each step.

### Windows: Install NSIS exe

On a Windows host (cross-compiling from macOS is not supported):

```powershell
# 0. Install native deps (first time / after changing Node versions)
pnpm install
# postinstall automatically runs electron-builder install-app-deps and rebuilds better-sqlite3 for Electron 33 ABI v130

# 1. Build NSIS installer + portable .exe
pnpm dist:win
# Artifacts are release\Agent Deck-<version>-x64.exe (installer) + Agent Deck-<version>-x64.exe (portable)

# 2. Double-click the installer to install into %LOCALAPPDATA%\Programs\Agent Deck\ (NSIS default perMachine=false)
#    During install, checking "add PATH" is optional. If unchecked, the wrapper is at
#    %LOCALAPPDATA%\Programs\Agent Deck\resources\bin\agent-deck.cmd

# 3. Add the wrapper to PATH from the command line (optional, lets any terminal directory run agent-deck ...)
$env:PATH += ";$env:LOCALAPPDATA\Programs\Agent Deck\resources\bin"
# Add permanently to user environment variables:
# [Environment]::SetEnvironmentVariable("PATH", $env:PATH, "User")
```

**Known Windows Differences** compared with macOS:

| Dimension | macOS Behavior | Windows Behavior |
|---|---|---|
| Window shape | Real under-window frosted-glass vibrancy + hidden traffic lights | `transparent + frame: false`; vibrancy / visualEffectState are silent no-ops and CSS fallback provides degraded visuals |
| Alert sound | afplay m4a / system Glass+Tink fallback | PowerShell + PresentationCore.MediaPlayer m4a / `[console]::beep` fallback (PresentationCore is absent on Win Server Core) |
| Notification | Notification + Dock bounce | Notification Center; no Dock concept, so it uses sound + notification |
| Default install directory | `/Applications/Agent Deck.app` | `%LOCALAPPDATA%\Programs\Agent Deck\Agent Deck.exe` |
| CLI wrapper | `agent-deck` (POSIX bash, symlinked into PATH) | `agent-deck.cmd` (works in cmd.exe and PowerShell) |

### Development Mode

```bash
pnpm install                                    # postinstall automatically runs electron-builder install-app-deps and rebuilds better-sqlite3;
                                                # electron / esbuild prebuilt binaries are allowed through pnpm.onlyBuiltDependencies
pnpm dev                                        # electron-vite + HMR
```

HMR only applies to renderer. After changing `src/main/**` or `src/preload/**`, restart dev.

### Authentication (Before First Use)

Claude Code / Codex paths do not read or write API keys. The Deepseek path only reads the token you put in `.deepseek/settings.json` and injects it into the corresponding SDK child process; it does not write it anywhere else.

- **Claude Code**: run `claude login` first (subscription or Console account is fine). The SDK reads `~/.claude/.credentials.json` itself. `permissions / hooks / env / mcpServers` in `~/.claude/settings.json` are inherited, equivalent to running `claude` in that cwd.
- **Deepseek (Claude Code)**: the first time you create this session type, Agent Deck automatically creates `~/.agent-deck/.deepseek/settings.json`; fill in `env.ANTHROPIC_AUTH_TOKEN` and it is ready to use. The file independently stores DeepSeek `ANTHROPIC_BASE_URL` / token / model names and default Fable / Opus / Sonnet / Haiku alias mappings. agents / skills / CLAUDE.md / MCP still reuse Claude Code-side resources.
- **Codex CLI**: run `codex auth` in a terminal first; the app directly reuses `~/.codex` config.

The `env` field from `~/.claude/settings.json` is injected into the main process at startup through an allowlist (`ANTHROPIC_*` / `CLAUDE_*` / standard proxy variables), so SDK child processes can receive proxy / custom base URL settings. Other keys such as `NODE_OPTIONS` / `PATH` are rejected.

---

## Command-Line Integration

The app packages platform wrappers. After symlinking into PATH, from any terminal:

```bash
# macOS / Linux (POSIX bash wrapper)
agent-deck                                # equivalent to agent-deck new --cwd "$PWD" --prompt "你好"
agent-deck --prompt "help me inspect this bug"  # wrapper automatically fills the new subcommand
```

```cmd
REM Windows (agent-deck.cmd works in cmd.exe and PowerShell)
agent-deck                                REM equivalent to agent-deck new --cwd "%CD%" --prompt "你好"
agent-deck --prompt "help me inspect this bug"  REM automatically fills new + --cwd "%CD%"
agent-deck new --cwd "C:\path\to\repo" --prompt "..."
```

Complete subcommands (common to macOS / Win):

```bash
agent-deck new \
  [--cwd <path>]                          # default comes from wrapper $PWD / %CD%; direct .app/.exe invocation uses ~ / %USERPROFILE%
  [--prompt "..."]                        # first message (default "你好", avoids the SDK 30s fallback)
  [--agent claude-code|deepseek-claude-code|codex-cli]  # short names --agent claude|deepseek|codex are supported; --adapter is equivalent
  [--model <provider-model-id>]            # free-text per-session model override
  [--thinking low|medium|high|xhigh|max|ultra]  # adapter validation applies
  [--permission-mode default|acceptEdits|plan|bypassPermissions]  # wrapper defaults to bypassPermissions
  [--codex-sandbox workspace-write|read-only|danger-full-access]  # only affects codex-cli
  [--resume <sessionId>]                  # resume historical jsonl
  [--team <name>] [--member <slug>:<adapter> ...]  # start a team: lead + teammates (--member is repeatable and requires --team)
  [--no-focus]                            # by default, focuses the front window and selects the new session
```

Installed package freshness:

```bash
agent-deck --version                      # print packaged version, commit, branch, dirty flag, and build time
agent-deck --check-installed              # exit non-zero when the installed app was not built from this checkout commit
```

Release builds include `build-info.json` in the app bundle (`Contents/Resources/build-info.json` on macOS, `resources\build-info.json` on Windows). When the command is run from inside an `agent-deck` source checkout, the wrapper compares that packaged commit with the local `HEAD` and local `origin/main` ref. A missing `build-info.json` means the app is an older package or was not built through the current packaging scripts.

When the app is not running, the OS starts it automatically (macOS Launch Services / Win shell). When it is already running, `requestSingleInstanceLock` forwards arguments to the main instance. Linux uses the `agent-deck` POSIX wrapper, same as macOS, and depends on bash 4+.

---

## Settings

The Settings panel opens from the gear button. It has three top-level tabs: **General** / **Claude Code** / **Codex CLI**. The General tab has four themed groups (**Sessions** / **Alerts And Appearance** / **Integration And Runtime** / **Cross-Tool Collaboration (MCP)**), and each group has sections whose titles can be collapsed / expanded (state is persisted in localStorage; only Lifecycle is expanded by default):

- **Sessions**
  - **Lifecycle**: active window in minutes / closed threshold in hours / permission-request timeout in minutes (default 30, 0 = no timeout, timeout means deny + interrupt) / history-session retention days / resolved issue / soft-deleted issue retention days / **cross-session message retention days** (default 30, 0 = disabled; pending/delivering in-flight messages are never deleted)
  - **Intermittent summaries**: used by session cards and the Summary view, never for hand-off or missing-history recovery. Controls include an enable switch (on by default), trigger interval / event count (default 30 events), concurrent summary limit (default 2; range 1–10), provider, model, and Thinking level. With an empty model, Claude and Deepseek use their Haiku alias, while Codex delegates to the model in `config.toml`. Each run freezes an event-revision boundary and builds a bounded read-only evidence snapshot; the card keeps a one-line headline while Summary history can show progress, next step, and risks.
  - **Continuation Context**: used by hand-off to a new session and missing-native-history recovery. Controls include automatic checkpoint maintenance (on by default), normal refresh interval (default 30 minutes; range 5–1,440), concurrent background-session limit (default 2; range 1–10), provider / model / Thinking, and a recent-user-input ceiling (default 64,000 tokens; range 8,000–128,000). Empty-model defaults are Claude Sonnet, Deepseek Sonnet, and the model in Codex `config.toml`.
    - **Refresh lifecycle**: the normal path requires at least 32,000 newly uncheckpointed normalized tokens, the configured interval since the checkpoint/session baseline, provider idle, and 60 seconds without persisted activity. At 48,000 newly uncheckpointed normalized tokens, the safety path bypasses interval, quiet, and provider-idle gates and queues background work without interrupting the active provider turn. The estimate revision is only an eligibility observation: when a bounded-concurrency job actually starts, it atomically captures the latest durable revision, so in-place tool updates that happened while queued are coalesced instead of disappearing behind an unreconstructible historical boundary. Failures back off for five minutes, and foreground hand-off / recovery takes priority over same-session queued or running background work.
    - **Bounded canonical state**: the persisted canonical checkpoint starts deterministic whole-fact pruning above about 20,000 estimated tokens and has a hard 24,000-token limit. Active / blocked facts, durable coverage-gap markers, and facts resolved or superseded in the current generation are protected; lower-priority inactive facts are evicted by status, priority, evidence recency, section priority, and stable id. If protected facts alone exceed the hard limit, persistence fails closed instead of truncating a required fact. Completed tool telemetry is conservatively deduplicated and compacted with bounded prefix/suffix evidence plus hashes so high-volume tool output cannot starve ordinary messages.
    - **Budget relationship**: the 32,000 / 48,000 refresh thresholds measure only new normalized evidence and are not prompt limits. A generator fold gets 96,000 input tokens when model capacity is unknown; with an observed capacity it gets `min(128,000, context window - 32,000)`, and the complete provider prompt also has a 512 KiB UTF-8 guard. The stored canonical checkpoint uses the separate 20,000 / 24,000 limits above. For the successor, target prompt capacity is the target context window minus 16,000 tokens reserved for system/project instructions and 8,000 for the response; the fixed wrapper and current continuation instruction are then deducted. The checkpoint projection receives 20% of the remaining historical capacity, clamped to 2,000–12,000 tokens. The recent raw-user tail gets what remains, capped by the user setting (64,000 by default), so “12k checkpoint + 64k raw” are ceilings rather than guaranteed allocations. No message-count setting controls these budgets.
    - **Failure boundary**: Codex compact generation uses the same hardened-but-unattested empty-cwd/read-only/no-network/no-MCP boundary as periodic summaries, then accepts output only after schema canonicalization, exact evidence allowlisting, active-fact carry-forward checks, bounded fitting, and revision-safe persistence. UI and MCP hand-off share a 300-second checkpoint deadline; missing-history recovery keeps its independent 30-second limit because it operates on an already frozen spool and must return quickly. Provider or validation failure falls back to the last valid checkpoint plus immutable raw history.
- **Alerts And Appearance**
  - **Alerts**: sound toggle, mute while focused, system-notification toggle, custom waiting / finished sounds (mp3 / wav / aiff / m4a / ogg / flac, with preview + reset)
  - **Window**: launch at login. Other window controls are documented in the separate Keyboard Shortcuts section.
  - **Keyboard shortcuts**: global keyboard-shortcut reference (read-only; see the "Keyboard Shortcuts" section below)
- **Integration And Runtime**
  - **Hook Server (local port)**: port (restart + reinstall hook required to take effect); Bearer token is auto-generated as persistent 256-bit hex on first launch and is not exposed in the UI
  - **External tools**: Codex / Claude binary paths (leave empty to use the app's vendored versions)
  - **Logs**: log verbosity dropdown (default `INFO`) affects only log-file content and applies immediately; there are also "open log directory / view log / clear today's log" action buttons (see "Development Guide -> Logs")
  - **Experimental features**:
    - **Claude Code sandbox**: uses the shared Read Only / Workspace Write / Full Access order and labels (default Workspace Write). Full Access disables Claude's OS sandbox but still follows Claude Code permission settings. OS isolation applies only on macOS (Seatbelt) / Linux (bubblewrap); **Windows currently does not support it**. This value is the global default; the new-session dialog can override it per session; a session can switch through a cold restart.
    - **Codex sandbox**: uses the same Read Only / Workspace Write / Full Access order and labels. Full Access can read or write any file, use the network, and run commands. Per-session changes apply from the next Codex turn without restarting the current turn; switching to Full Access still asks for confirmation.
- **Cross-Tool Collaboration (MCP)**
  - **Agent Deck MCP server (on by default)**: after enabling it, in-app and per-session claude / deepseek / codex callers can orchestrate other coding-agent sessions across adapters, present plans and diffs to users for confirmation or feedback, manage structured tasks, and report issues through 19 tools (7 session / messaging: `spawn_session` / `send_message` / `list_sessions` / `get_session` / `list_session_events` / `shutdown_session` / `hand_off_session`; 2 user presentation: `present_plan` / `present_diff`; 2 worktree: `enter_worktree` / `exit_worktree`; 5 task: `task_create` / `task_list` / `task_get` / `task_update` / `task_delete`; 3 issue: `report_issue` / `append_issue_context` / `update_issue_status`). Third-party MCP clients can connect through the external transport, with available tools limited by the external-caller restrictions below. `spawn_session.model` and `hand_off_session.model` accept maintained suggestions grouped by adapter: Claude (`haiku`, `sonnet`, `opus`, `fable`), Codex (`gpt-5.6-sol`, `gpt-5.6-terra`, `gpt-5.6-luna`, `gpt-5.5`, `gpt-5.4`), and Deepseek (`v4-flash`, `v4-pro`). These suggestions are not an allowlist: any non-empty provider model id is passed through for provider validation; only the two Deepseek aliases expand to `deepseek-v4-flash` and `deepseek-v4-pro[1m]`. Transport:
    `spawn_session` and `hand_off_session` model / thinking overrides apply only to the target session and never rewrite global defaults. Precedence for spawn is explicit argument > resolved agent config > provider default. A same-adapter hand-off inherits omitted model / thinking values from the caller; a cross-adapter hand-off uses target-provider defaults unless explicitly overridden. Codex thinking accepts `low` / `medium` / `high` / `xhigh` / `max` / `ultra`; Claude and Deepseek accept `low` / `medium` / `high` / `xhigh` / `max`. The provider remains authoritative for model-specific support. Creation failures preserve the underlying error and add an actionable `hint`; retry with its exact value or action, or omit the rejected optional override. Claude-family sessions replace requested aliases with the concrete model reported at SDK initialization and update displayed effort when a completed turn reports the actual level; Codex sessions persist the selected or valid top-level configured reasoning effort.
    `spawn_session.contextMode` accepts `fresh` or `fork` and defaults to `fresh`. A requested fork can use only the authenticated active SDK caller, requires the exact caller adapter and a target cwd resolving to the same real directory, and never accepts a source session id or turn count. It clones native provider history through the safe active-turn boundary: prior history and the current user request are included, while unfinished assistant reasoning/output, tool activity, and the active `spawn_session` frame are excluded. Successful fork results add `contextMode: "fork"` and the Agent Deck `forkedFromSessionId`; provider-native ids are not returned. If a fork fails, follow its exact hint or use `fresh`; there is no silent downgrade. When a first-turn Codex caller has no terminal prefix, Agent Deck creates an independent zero-prefix target thread and replays the current native `UserInput` values before the delegated prompt. Native forks can carry large history, so use `fresh` when inherited context is unnecessary. `hand_off_session` always remains fresh: its `prompt` is the authoritative continuation instruction, while Agent Deck privately prepends the same versioned Continuation Context used by UI hand-off and missing-history recovery. Its result contains compact checkpoint/revision/token metadata rather than the provider prompt. The full persisted history stays with the source session. Before source close, tasks / active teams / the worktree marker / in-flight message endpoints move to the successor; existing issue source/resolution authority, pending plan gates, and related-session visibility follow the committed ownership chain without rewriting provenance.
    - **in-process**: mounted automatically for claude SDK sessions
    - **HTTP** `/mcp`: injected into Codex SDK config at startup as `mcp_servers.agent-deck` (independent Bearer token referenced through env var `AGENT_DECK_MCP_TOKEN`); external MCP clients can also connect
    - **external caller restrictions**: connections without per-session identity (external MCP client / HTTP global-token fallback) may use only 3 read-only tools (`list_sessions` / `get_session` / `task_list`). The other 16 tools (`spawn_session` / `send_message` / `present_plan` / `present_diff` / `list_session_events` / `shutdown_session` / `hand_off_session` / `enter_worktree` / `exit_worktree` / `task_create` / `task_get` / `task_update` / `task_delete` / `report_issue` / `append_issue_context` / `update_issue_status`) always deny external callers to prevent fork bombs / cross-client privilege escalation; `list_session_events` is read-only but still needs a real caller identity for self / spawn / active-team visibility checks. stdio transport code is ready, but the `agent-deck mcp` CLI entry is not wired yet.

    `list_sessions` defaults to the real caller's related sessions: its current committed handoff ownership chain, spawn ancestors / descendants, and sessions that share an active team. `adapterFilter` is unset by default, so all adapters are included unless the caller narrows it; when set, it is pushed into the session query before pagination. Explicit `spawnedByFilter` recovery searches and external read-only discovery stay broad and support `offset` + `limit` pagination with `hasMore`, so reset/rescue workflows can still page through stranded sessions. `list_session_events` returns paged normalized SQLite activity events for that ownership chain, spawn ancestors / descendants, or active-team peers; it never reads raw Claude / Codex transcript files.

    Recursion protection: max spawn-chain depth (default 3) / per-minute spawn limit (default 20) / max child sessions per caller (default 10) / cwd realpath cycle detection across the entire chain. Message rate limit (default 60/min): team messages use per-team buckets, and teamless DMs use per-sender buckets shared across all receivers for the same sender. Replies no longer poll-wait; after `send_message` delivers, universal-message-watcher automatically injects into the target session and reply chain. Task tools automatically close over `owner_session_id = caller_session_id`; write permissions are shared with active team members; `hand_off_session` automatically transfers tasks with the baton. Existing issue records keep their original source/resolution session ids for provenance, while append/status authority follows the current committed successor. Issue records also store cwd and best-effort git branch snapshots for triage context. The settings UI exposes all Agent Deck MCP server thresholds. Protocol details are governed by this README, bundled CLAUDE.md / CODEX_AGENTS.md, and MCP tool descriptions.

The Claude Code and Codex CLI tabs use the same Runtime Configuration / Terminal Integration / In-App Features help template. Each tab installs or uninstalls its user-scope terminal Hook. The bottom of General has **Reset to default configuration**; it restores configurable preferences while preserving installation authentication tokens and installed terminal Hooks.

> Asset injection switches are at the top of the Header "Asset Library" dialog's three tabs, not duplicated in Settings, to avoid multiple sources of truth for one switch.

Most settings apply immediately. Hook installation and port changes require reinstalling the hook. Sandbox level / Agent Deck MCP transport toggles / asset injection switches are spawn-time injections and affect only newly created sessions. Agent Deck MCP recursion thresholds (depth / spawn-rate / fan-out / message rate) apply hot.

The **Asset Library** button on the right side of the Header toolbar opens an independent dialog that shows bundled Agent Deck assets plus user-defined `~/.claude/{agents,skills}/` and `~/.codex/{agents,skills}/` assets: agents/skills and app-level CLAUDE.md / CODEX_AGENTS.md. Each tab has an injection-switch bar at the top (Skills tab: Claude bundled Skills + Codex bundled Skills; Agents tab: Claude bundled Agents + Codex bundled Agents; App conventions tab: Claude app conventions + Codex app conventions). These switches control only bundled Agent Deck resources; user / project agents and skills are unaffected. Bundled resources are Agent Deck's behavior baseline; user-defined agents/skills are an enhancement layer and cannot replace bundled protocol or reviewer discipline. Deepseek (Claude Code) does not maintain a separate asset view; session creation and `spawn_session(agentName=...)` reuse Claude-side agents/skills/CLAUDE.md, and only model/auth env are read from `.deepseek`. agents/skills support creating / editing / deleting user copies; saved copies are visible to the next new session.

---

## Keyboard Shortcuts

App-global shortcuts are registered through OS-level `globalShortcut`, so they work even when Agent Deck is not focused. Linux/Windows use `Ctrl` instead of `Cmd`.

| Shortcut | Behavior |
|---|---|
| `Cmd+Alt+P` | Toggle the main window always-on-top state (syncs the "Settings -> Window -> Always on top" switch) |
| `Cmd+Alt+T` | Toggle "transparent while pinned" on the main window (syncs the "Settings -> Window -> Transparent while pinned" switch; while pinned, immediately switches CSS frosted-frame + macOS vibrancy; while not pinned, only updates the setting for the next pin) |
| `Cmd+Alt+=` | Expand to the screen maximum in one step (workArea minus 40px margins); press again to return to the previous manual size (shared memory with `Cmd+Alt+-`) |
| `Cmd+Alt+-` | Return to the default 520x680 in one step; press again to return to the previous manual size (shared memory with `Cmd+Alt+=`) |

> macOS browser `Cmd+Shift+T` (reopen closed tab) is intercepted by OS-level `globalShortcut`, so Agent Deck uses `Cmd+Alt+T`, consistent with `Cmd+Alt+P` naming and avoiding common browser shortcuts. `Cmd+Alt+=` / `Cmd+Alt+-` are orthogonal to browser page zoom shortcuts `Cmd+=` / `Cmd+-`.

---

## Project Structure

```
src/
├── main/                  Electron main process
│   ├── index.ts           startup entry (DB -> adapters -> HookServer -> window -> IPC -> CLI argv)
│   ├── cli.ts             agent-deck new subcommand parser; shared by first launch + second-instance
│   ├── window.ts          FloatingWindow (vibrancy / pin / compact)
│   ├── ipc/               centralized IPC handlers (split by domain); settings.ts dispatches runtime setting changes
│   ├── event-bus.ts       main-process event bus
│   ├── hook-server/       shared fastify instance + RouteRegistry (adapters register routes dynamically)
│   ├── adapters/
│   │   ├── claude-code/   hook routes + hook installer + SDK bridge + CLAUDE.md / skill / agents injection + sandbox-config (three OS isolation modes)
│   │   ├── deepseek-claude-code/ Claude Code SDK profile wrapper; injects DeepSeek env from ~/.agent-deck/.deepseek/settings.json and reuses Claude-side resources
│   │   └── codex-cli/     codex app-server JSON-RPC bridge + hook routes/installer for external terminal sessions
│   ├── agent-deck-mcp/    Agent Deck MCP server (19 tools + in-process / HTTP transport + spawn-guards / rate-limiter)
│   ├── session/           SessionManager / LifecycleScheduler / Summarizer
│   ├── teams/             Universal Team Backend: universal-message-watcher (cross-adapter team-message delivery) + team-lifecycle-scheduler
│   ├── notify/            sound.ts (cross-platform playback + overlap prevention + 5s cap) / visual.ts (system notification + Dock)
│   ├── permissions/       scanner for the Session Detail Permissions tab (user / user-local / project / local layers)
│   ├── bundled-assets.ts  startup cache for bundled agent-deck plugin agents/skills frontmatter
│   ├── user-assets.ts     user-defined ~/.claude/{agents,skills}/ management (list/save atomic write/delete/reveal)
│   ├── utils/
│   │   └── logger.ts      electron-log v5 main wrapper (daily split + 14-day cleanup + scoped logger + fatal hook + console takeover)
│   └── store/             better-sqlite3 + migrations + repos + electron-store settings
├── preload/index.ts       contextBridge exposes window.api / window.electronIpc (including static process.platform field)
├── renderer/              React 19
│   ├── App.tsx            header (title / stats / pending chip / plus / six tabs: Live / Pending / History / Team / Issues / Data / pin / collapse / Asset Library / Settings)
│   ├── components/        FloatingFrame · SessionList · SessionCard · SessionDetail ·
│   │                      PendingTab · pending-rows · PermissionsView · HistoryPanel ·
│   │                      NewSessionDialog · SettingsDialog (split settings/sections/*) ·
│   │                      AssetsLibraryDialog · assets/AssetEditor ·
│   │                      activity-feed (Task rendering) · diff/ ·
│   │                      IssuesPanel · IssueDetail · DataPanel (token statistics) ·
│   │                      TeamHub · TeamDetail (Universal Team Backend view through agent-deck-team:* IPC + universal-message-watcher delivery)
│   ├── stores/            Zustand session store
│   ├── hooks/             event bridge
│   ├── utils/
│   │   └── logger.ts      electron-log v5 renderer wrapper (IPC bridge forwards to main -> same main-YYYY-MM-DD.log)
│   └── lib/               IPC fallback + selectors (selectLiveSessions / selectPendingBuckets) + platform.ts (IS_DARWIN/IS_WIN/IS_LINUX renderer util)
└── shared/                types (must not import Electron / Node APIs) + mcp-tools

resources/
├── icon.png               Dock / window icon (1024x1024)
├── icon.ico               Win NSIS / portable icon (multi-size bundle generated by pnpm icon:gen)
├── sounds/                bundled waiting / done alert sounds
├── bin/
│   ├── agent-deck         macOS / Linux CLI wrapper (POSIX bash, chmod +x)
│   └── agent-deck.cmd     Windows CLI wrapper (cmd.exe / PowerShell compatible)
├── claude-config/         bundled CLAUDE.md + agent-deck-plugin (agents/skills), copied into .app by extraResources
└── codex-config/          Codex counterpart assets: CODEX_AGENTS.md + agent-deck-plugin (see resources/README.md)

scripts/
├── gen-icon-ico.mjs       generates icon.ico from icon.png (pnpm icon:gen)
├── test-electron.mjs      runs vitest with Electron's built-in node (ABI 130) so better-sqlite3 unit tests really run instead of skipping (pnpm test)
├── verify-fts5.sh         real sqlite3 CLI SQL integration check (FTS5 schema + triggers + MATCH predicates)
├── logger-check.sh        grep CI guard: 0 remaining console.X under src/main + src/renderer, plus logger.ts module-independence self-check (pnpm logger:check; requires ripgrep)
├── file-level-review-expiry.sh  mechanical review-expiry check (see CLAUDE.md §Review Expiry And Minimum Re-Review Scope)
└── ref-archive-reminder-pre-commit.sh  installs the advisory .ref archive reminder hook

ref/
├── changelogs/            feature and behavior records in four date buckets
├── reviews/               debug, performance, security, and review-driven records in the same buckets
└── plans/                 final plans and durable support material in the same buckets

.ref/                      ignored workspace for non-final LLM-facing material
```

---

## Development Guide

```bash
pnpm typecheck       # required
pnpm test            # vitest through scripts/test-electron.mjs with Electron's built-in node, so better-sqlite3 unit tests really run; file-level `// @vitest-environment happy-dom` switches React hook tests
pnpm test:node       # vitest through system node (SQLite unit tests gracefully skip; useful for fast iteration on non-SQLite tests)
pnpm test:fts5       # real sqlite3 CLI SQL integration check (FTS5 schema + triggers + MATCH predicates, no better-sqlite3 dependency)
pnpm logger:check    # grep CI guard: 0 remaining console.X under src/main + src/renderer, plus logger.ts module independence (requires ripgrep: brew install ripgrep)
pnpm build           # run for large changes
pnpm dist            # build dmg + .app
```

### Logs (Runtime Logging)

The app uses [electron-log v5](https://github.com/megahertz/electron-log) for dual-process file logging + console takeover + fatal hook:

- **Location** by platform:
  - macOS: `~/Library/Logs/Agent Deck/main-YYYY-MM-DD.log` (daily split + 14-day retention)
  - Windows: `%USERPROFILE%\AppData\Roaming\Agent Deck\logs\`
  - Linux: `~/.config/Agent Deck/logs/`
- **Settings -> Integration And Runtime -> Logs** adjusts the verbosity written to log files (default `INFO`) and applies immediately; the development terminal still keeps full output for local debugging.
- Action buttons in the same section: open log directory / view log (read-only Monaco modal inside the app, showing today's `main-YYYY-MM-DD.log`; files > 2MB show only the tail 2MB) / clear today's log.
- **Business-module usage**:
  - main: `import log from '@main/utils/logger'; const logger = log.scope('<kebab-name>'); logger.info(...);`
  - renderer: `import log from '@renderer/utils/logger'; const logger = log.scope('<kebab-name>'); logger.info(...);` (automatically forwarded through IPC bridge to main and written to the same file)
- **`NODE_ENV='test'` skips console takeover** so vitest `vi.spyOn(console)` keeps passing unchanged. vitest-setup.ts globally mocks electron-log/main + electron-log/renderer + electron-store + electron so main unit tests can import business modules without hitting `Electron failed to install`.
- **fatal hook** (uncaughtException + unhandledRejection) is installed during logger init and writes crashes to disk, preventing silent .app crashes from losing stacks.
- **New console.\* calls are blocked by `pnpm logger:check`**. The grep CI script verifies 0 remaining calls plus logger.ts invariant 8 module independence.

### Data Storage

SQLite lives under the app userData directory as `agent-deck.db`:

- macOS: `~/Library/Application Support/Agent Deck/`
- Windows: `%APPDATA%\Agent Deck\`
- Linux: `~/.config/Agent Deck/`

Schema version advances incrementally through the `user_version` pragma. Migration files live in `src/main/store/migrations/`; the current version is the latest file in that directory. Tables: `sessions / events / file_changes / summaries / app_meta / tasks / agent_deck_teams / agent_deck_team_members / agent_deck_messages / issues / issue_appendices / token_usage`.

The v43 history-search upgrade is intentionally offline for an existing database. First observe the
database path from the running app, quit Agent Deck completely, then pass that exact path to:

```bash
pnpm migrate:history-search -- --db "/observed/path/agent-deck.db"
```

The command refuses active Agent Deck processes or open database handles, migrates and validates a
copy, atomically switches files, and retains the timestamped `.bak` path it prints. After the new app
passes event and summary case-insensitive History smoke tests, quit it again and finalize with the
printed backup path:

```bash
pnpm migrate:history-search -- --finalize --smoke-passed \
  --db "/observed/path/agent-deck.db" --backup "/printed/path/agent-deck.db.<timestamp>.bak"
```

### Key Ports

- `47821` HookServer (configurable in Settings)
- `5173` vite renderer dev server

### Validate Hook Channel

```bash
# Bearer token is auto-generated on first launch and stored in the hookServerToken settings field
curl -sS -X POST http://127.0.0.1:47821/hook/sessionstart \
  -H 'Content-Type: application/json' \
  -H "Authorization: Bearer <token>" \
  -d '{"session_id":"test-001","cwd":"<any-directory>"}'
```

### Packaging Rules

- `package.json > build.mac.icon = "resources/icon.png"` must be specified explicitly.
- `package.json > build.win.icon = "resources/icon.ico"` must be specified explicitly; after icon changes, run `pnpm icon:gen` to regenerate `.ico`.
- `extraResources` must explicitly copy `resources/bin -> bin` so the wrappers (`agent-deck` POSIX + `agent-deck.cmd` Win) enter the .app / NSIS install dir.
- Packaging scripts must generate `build/build-info.json`, ship it as bundled `build-info.json`, and include package/app name, semantic version when available, full git commit, short commit, branch when available, dirty flag when determinable, and build timestamp. Keep `agent-deck --version` / `agent-deck --check-installed` working against installed metadata without fetching remotes.
- After installing the package, run `codesign --force --deep --sign -` for ad-hoc re-signing (macOS only).
- Before overwrite installs, close the old main process: use `pkill` on macOS and `taskkill /F /IM "Agent Deck.exe"` on Windows. Do not delete or overwrite a running bundle because the current instance will lose resources and execution channels. If killing is inconvenient, follow the handling rule in [CLAUDE.md](CLAUDE.md) §Packaging Configuration Rules.
- `asarUnpack` must include `@openai/codex/**` and all platform subpackages of `@anthropic-ai/claude-agent-sdk` (darwin / linux / win32 x arm64 / x64).
- **Win packages must be built with `pnpm dist:win` on a Windows host or Windows CI runner.**

## Further Reading

Repository history and final engineering context use three routed indexes:

- [ref/changelogs/INDEX.md](ref/changelogs/INDEX.md) - **feature changes** index (new features / behavior changes / API / dependency upgrades)
- [ref/reviews/INDEX.md](ref/reviews/INDEX.md) - **debug / performance / security review** index (fixes or hardening without introducing new features)
- [ref/plans/INDEX.md](ref/plans/INDEX.md) - final implementation plans and durable supporting context
- [CLAUDE.md](CLAUDE.md) - hard requirements, project design notes, and validation workflow for Claude Code working in this repository

Design tradeoffs, such as why lifecycle and archived are orthogonal, usually live in changelogs. Past bugs and hardening plans live in reviews. Before changing a module, follow the reading order in [CLAUDE.md](CLAUDE.md) "Required After Changes".
