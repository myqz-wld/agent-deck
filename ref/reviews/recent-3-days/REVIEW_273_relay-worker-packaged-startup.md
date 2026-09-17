---
review_id: 273
reviewed_at: 2026-09-16
baseline_commit: 540c3319c7f7065b256adc76e019d00295b43b38
expired: false
---

# Relay live acceptance and packaged Worker startup

## Scope and method

Exercise the existing Relay installation through the official deployment verification commands,
the production SSH client, and read-only service diagnostics. Reproduce and repair the confirmed
packaging defect, then validate the replacement artifact outside the source checkout. This is an
operational debugging pass; no independent reviewer sessions were requested or started. The
repository review-expiry inventory was consulted without relying on previous coverage exemptions.

```review-scope
scripts/build-linux-headless.mjs
scripts/check-linux-headless.mjs
scripts/check-local-worker-bundle.mjs
```

## Finding

### HIGH — Installed Worker cannot load its entrypoint

The installed Desktop and source both identify commit `540c3319`. The official Worker verification
exits unsuccessfully. Running the installed Worker wrapper's `status` command reproduces
`ERR_MODULE_NOT_FOUND` for `@iarna/toml` before command dispatch. The existing Worker LaunchAgent
reports a scheduled spawn with exit code 1, and its stderr log repeatedly records the same import
failure. This prevents the Worker from attaching to Relay.

The `local-worker` build externalized JavaScript dependencies, leaving a bare ESM import of
`@iarna/toml` in the shipped entrypoint. The macOS wrapper's `NODE_PATH` cannot resolve this ESM
import. Tests and package checks running beneath the checkout can resolve dependencies from its
ancestor `node_modules`, masking the installed failure.

## Source repair

- Bundle the Worker's JavaScript dependencies while retaining the explicit native SQLite
  external. Use strict CommonJS wrapping for reproducible output.
- Add `scripts/check-local-worker-bundle.mjs`. It copies the real built entrypoint and example
  configuration into an external temporary directory, removes `NODE_PATH` and `NODE_OPTIONS`,
  and executes `check-config` with a bounded timeout.
- Run that isolated startup check during both the reproducible headless build and the headless
  verification entrypoint, including the build path used by macOS packaging.
- The isolated check failed on the original artifact with the same missing-package error and
  passed after the repair. Temporary files are removed on success and failure.

The source repair is prepared but has not replaced the running installed application.

## Live evidence

| Operation | Observed result |
|---|---|
| `pnpm deploy:relay-server -- --config <private-server-config> --verify` | `VERIFY_OK`, container healthy, Feishu runtime files ready |
| `pnpm deploy:relay-worker -- --config <private-worker-config> --verify` | Fails; direct installed `status` identifies the missing TOML dependency |
| Production SSH client connection using the configured Desktop profile | Two bounded attempts fail after approximately 3.5 seconds; remote stderr reports Relay startup failure and the client becomes offline |
| Read-only Relay metadata | Worker offline; Desktop route closed; Worker and Desktop credentials active |
| Read-only SSH forced-command inspection | Canonical Desktop surface and expected control sockets present |
| Read-only instance record | Generation 18, current `git-f6d977adcbd0`, previous `git-4fd970044463` |
| Local Grok Provider supervisor | Configuration and LaunchAgent file exist, but the service is not loaded |

Relay health measures the relay service independently of Worker readiness. Its healthy result does
not establish a working business session. The remote release is older than the installed Desktop;
this run does not claim latest-release server deployment acceptance.

## Validation

- Initial focused Relay, Worker, SSH, remote-service, and remote-renderer suite: 108 files and
  594 tests passed, despite the installed failure.
- `pnpm typecheck` passed, including architecture checks.
- `pnpm test`: 1,027 files and 6,363 tests passed; two files and three tests retained their existing
  opt-in skips. The Electron-compatible runner was used without manually swapping SQLite bindings.
- `pnpm build:linux-headless` passed reproducibility and the isolated entrypoint check.
- `pnpm check:linux-headless` passed.
- `pnpm dist:mac` passed, including the production build, native Worker sandbox checks, and
  packaged Worker runtime checks.
- A disposable copy of the complete new application was moved outside the repository. The
  packaged Worker sandbox suite and wrapper `check-abi` both passed there with `NODE_PATH` and
  `NODE_OPTIONS` removed. The expected outside-Workspace denial was observed. That application
  copy and its temporary runtime data were removed afterward.
- The repair artifact is `build/dist/Agent Deck-0.1.0-arm64.dmg`. The packaged application remains
  under `build/dist/mac-arm64/Agent Deck.app` for inspection. Its build records the source as dirty;
  the repair has not been committed or installed.
- All three changed scripts are below 500 lines; `git diff --check` passed.
- Archive routing and index checks passed for 273 reviews, 153 plan entries including legacy
  nested plans, and 644 changelogs. Forty-six dated records and one associated support directory
  were rebucketed; existing row order and evidence links were preserved.

## Residual risk and next action

- The installed Worker remains broken until the replacement application is installed and the
  associated Worker is started. No existing process, service, installed bundle, credential,
  workspace configuration, or remote release was stopped, replaced, or upgraded in this task.
- Installation must follow explicit approval for the exact Desktop and Worker lifecycle actions.
  Stopping the hosting Desktop can interrupt this session. The configured Grok supervisor also
  needs its authorized lifecycle restored before claiming Grok acceptance.
- After restoration, rerun official Worker verification and the actual SSH handshake, then verify
  session creation, message round trips, and reconnection. These flows remain untested because
  the existing Worker is offline; passing unit tests does not substitute for them.
- The session Browser CLI was available and had no tabs. No native Desktop UI was controlled and
  no page or visual acceptance is claimed. No Browser tabs were created or left open.
- Archive rebucketing and link maintenance accompany the required final evidence records.
- The small operational probes under `.ref/reviews/` remain intentionally non-final material for
  the pending installed acceptance. Raw build/test logs were summarized here and removed.

Related plan: [Relay operational acceptance](../../plans/recent-3-days/PLAN_52_relay-worker-live-acceptance.md).
