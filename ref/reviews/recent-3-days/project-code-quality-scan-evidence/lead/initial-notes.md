# Lead scan evidence

Baseline: `072dd7a284eebc2752dab7e5d5505aa2ee480b77`. Source and Git remain unchanged.

## Validation completed

- `pnpm typecheck`: passed, including architecture boundaries, 121 Core-to-Node boundary candidates, Node TypeScript and renderer TypeScript.
- `pnpm check:deployment`: passed. It executes syntax and static checks; no deployment was attempted.
- CLI syntax: `bash -n` passed for the desktop, Worker and Provider supervisor wrappers; `node --check` passed for the Browser CLI and local macOS installer.
- All 34 package scripts have existing directly referenced script paths. Every non-generated `extraResources` source exists.
- The static import graph follows 14 production roots: Electron main/preload/renderer plus all 11 declared headless roles. It includes literal dynamic imports, type imports/exports and `?nodeWorker` imports. It reaches 1,602 of 1,619 non-test-pattern TypeScript modules. All 17 remaining files are current test helpers/fixtures with test callers. The only unresolved source-like import is the actual `schema.sql` asset. The two computed runtime-module imports require configured build roots; both current runtime bundles are already explicit roots.
- `pnpm run test scripts/deployment --maxWorkers=2 --minWorkers=1`: 4 files, 29 tests passed using the existing Electron-compatible wrapper. No binding rebuild occurred.
- `node --test scripts/install-local-macos.test.mjs`: 4 tests passed using the file's native Node test runner; temporary symlink fixtures were isolated.
- `git diff --check` passed and `git status --short` remained empty.

## LEAD-01: Existing installer tests are omitted from the default regression command

- Classification: LOW; confirmed validation integration gap, not an observed installer behavior defect.
- Evidence: `vitest.config.ts:27` includes only `src/**/*.test.ts`, `src/**/*.test.tsx`, and `scripts/deployment/**/*.test.mjs`. `scripts/install-local-macos.test.mjs:5` uses `node:test`; `package.json` provides no Node-test runner script for it.
- Ordinary trigger/current cost: a maintainer runs the documented `pnpm test` after editing installer path or symlink logic; four existing installer regression tests never execute. Even selecting that file through the default wrapper reports no test files.
- Verification: explicit default selection exited 1 with `No test files found`. A disposable Vitest config proved that adding the filename alone is insufficient: native Node TAP tests execute but Vitest reports no suite. Running the correct `node --test` command passes all four tests.
- Direction: add an explicit Node-test step to the project test command, or migrate these four tests to the existing Vitest runner and expand the include pattern. No source changes were made.
- Evidence files: `installer-test-discovery.log`, `installer-tests-isolated.log`, `installer-node-tests.log`.

## Candidates rejected or narrowed

- A missing subprocess stdin error listener was investigated against the exact 18,408-byte remote-install script payload and an early-exit child. Three isolated runs produced the expected caught error without an unhandled exception. This is not an admitted finding.
- Arbitrary service-home configuration and quota evidence initially looked inconsistent. Current remote preflight explicitly restricts the supported service home; this is not a demonstrated supported deployment defect.
- Feishu version/ABI metadata is repeated across build and independently deployed validation layers. Current values match. Duplication alone does not establish a defect or justify removing trust-boundary validation.
- There is no new confirmed whole-file dead code in the production graph. Symbol-level or runtime-unreachable branches remain for the worker scans to assess.

## Limits

This is a broad source/contract scan with focused validation. It is not a new package build, complete test-suite run, deployment, live Browser/provider smoke, or exhaustive proof of all runtime paths. No running or installed application was restarted or replaced. Worker findings and actual coverage are still pending.
