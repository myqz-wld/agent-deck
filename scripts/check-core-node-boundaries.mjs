#!/usr/bin/env node

import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'vite';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const aliases = Object.fromEntries([
  'clients',
  'composition',
  'contracts',
  'core',
  'gateways',
  'hosts',
  'main',
  'protocol',
  'shared',
].map((name) => [`@${name}`, resolve(repoRoot, `src/${name}`)]));

const candidates = Object.freeze([
  {
    name: 'safe-diagnostic-text-core',
    entry: 'src/core/safe-diagnostic-text.ts',
    external: [],
  },
  {
    name: 'claude-create-session-core',
    entry: 'src/main/adapters/claude-code/sdk-bridge/create-session/create-session-impl.ts',
    external: [],
  },
  {
    name: 'claude-jsonl-fallback-core',
    entry: 'src/main/adapters/claude-code/sdk-bridge/jsonl-fallback.ts',
    external: [],
  },
  {
    name: 'claude-recovery-core',
    entry: 'src/main/adapters/claude-code/sdk-bridge/recoverer/recover-and-send-impl.ts',
    external: [],
  },
  {
    name: 'claude-sdk-bridge-core',
    entry: 'src/main/adapters/claude-code/sdk-bridge/index.ts',
    external: [],
  },
  {
    name: 'codex-sdk-bridge-core',
    entry: 'src/main/adapters/codex-cli/sdk-bridge/index.ts',
    external: [],
  },
  {
    name: 'codex-aggregate-host-core',
    entry: 'src/main/adapters/codex-cli/aggregate-host-core.ts',
    external: [],
  },
  {
    name: 'codex-hook-installer-core',
    entry: 'src/main/adapters/codex-cli/hook-installer.ts',
    external: [],
  },
  {
    name: 'codex-hook-routes-core',
    entry: 'src/main/adapters/codex-cli/hook-routes.ts',
    external: [],
  },
  {
    name: 'grok-build-bridge-core',
    entry: 'src/main/adapters/grok-build/bridge.ts',
    external: ['better-sqlite3'],
  },
  {
    name: 'hook-route-diagnostics-core',
    entry: 'src/main/hook-server/route-diagnostics.ts',
    external: [],
  },
  {
    name: 'authoritative-database',
    entry: 'src/main/store/db.ts',
    external: ['better-sqlite3'],
  },
  {
    name: 'event-repository-core',
    entry: 'src/main/store/event-repo.ts',
    external: ['better-sqlite3'],
  },
  {
    name: 'event-repository-diagnostics-core',
    entry: 'src/main/store/event-repo-diagnostics-core.ts',
    external: [],
  },
  {
    name: 'session-repository-core',
    entry: 'src/main/store/session-repo/index.ts',
    external: ['better-sqlite3'],
  },
  {
    name: 'session-repository-diagnostics-core',
    entry: 'src/main/store/session-repo/diagnostics-core.ts',
    external: [],
  },
  {
    name: 'server-core-provider-settings',
    entry: 'src/hosts/server-core/provider-settings.ts',
    external: [],
  },
  {
    name: 'server-core-session-manager',
    entry: 'src/hosts/server-core/session-manager.ts',
    external: [],
  },
  {
    name: 'server-core-project-catalog',
    entry: 'src/hosts/server-core/project-catalog.ts',
    external: [],
  },
  {
    name: 'server-core-runtime-metadata',
    entry: 'src/hosts/server-core/runtime-metadata-store.ts',
    external: ['better-sqlite3'],
  },
  {
    name: 'server-core-runtime',
    entry: 'src/hosts/server-core/runtime-core.ts',
    external: [],
  },
  {
    name: 'server-core-repository-host',
    entry: 'src/hosts/server-core/repository-host.ts',
    external: ['better-sqlite3'],
  },
  {
    name: 'server-core-session-console-authority',
    entry: 'src/hosts/server-core/session-console-authority.ts',
    external: [],
  },
  {
    name: 'server-core-concrete-runtime',
    entry: 'src/hosts/server-core/runtime-composition.ts',
    external: ['better-sqlite3'],
  },
  {
    name: 'application-host-paths',
    entry: 'src/main/runtime-host/application-paths.ts',
    external: [],
  },
  {
    name: 'application-data-paths',
    entry: 'src/main/paths.ts',
    external: [],
  },
  {
    name: 'application-resources',
    entry: 'src/main/runtime-host/application-resources.ts',
    external: [],
  },
  {
    name: 'bundled-asset-store',
    entry: 'src/main/bundled-asset-store.ts',
    external: [],
  },
  {
    name: 'claude-md-store',
    entry: 'src/main/adapters/claude-code/claude-md-store.ts',
    external: [],
  },
  {
    name: 'claude-binary-resolution',
    entry: 'src/main/adapters/claude-code/binary-resolution.ts',
    external: [],
  },
  {
    name: 'claude-plugin-mirror-store',
    entry: 'src/main/adapters/claude-code/plugin-mirror-store.ts',
    external: [],
  },
  {
    name: 'claude-runtime-selection',
    entry: 'src/main/adapters/claude-code/runtime-selection.ts',
    external: [],
  },
  {
    name: 'claude-mcp-server-core',
    entry: 'src/main/adapters/claude-code/sdk-bridge/mcp-server-core.ts',
    external: [],
  },
  {
    name: 'claude-adapter-init-core',
    entry: 'src/main/adapters/claude-code/adapter-init-core.ts',
    external: [],
  },
  {
    name: 'claude-adapter-core',
    entry: 'src/main/adapters/claude-code/adapter-core.ts',
    external: [],
  },
  {
    name: 'claude-aggregate-host-core',
    entry: 'src/main/adapters/claude-code/aggregate-host-core.ts',
    external: [],
  },
  {
    name: 'claude-hook-routes-core',
    entry: 'src/main/adapters/claude-code/hook-routes.ts',
    external: [],
  },
  {
    name: 'claude-sdk-injection-core',
    entry: 'src/main/adapters/claude-code/sdk-injection-core.ts',
    external: [],
  },
  {
    name: 'codex-plugin-paths',
    entry: 'src/main/adapters/codex-cli/codex-config-paths.ts',
    external: [],
  },
  {
    name: 'codex-instance-pool-store',
    entry: 'src/main/adapters/codex-cli/instance-pool-store.ts',
    external: [],
  },
  {
    name: 'codex-instance-pool-core',
    entry: 'src/main/adapters/codex-cli/instance-pool-core.ts',
    external: [],
  },
  {
    name: 'codex-usage-probe-store',
    entry: 'src/main/adapters/codex-cli/usage-probe-store.ts',
    external: [],
  },
  {
    name: 'codex-usage-snapshot-core',
    entry: 'src/main/adapters/codex-cli/usage-snapshot-core.ts',
    external: [],
  },
  {
    name: 'codex-summary-runner-core',
    entry: 'src/main/adapters/codex-cli/summarizer-runner-core.ts',
    external: [],
  },
  {
    name: 'codex-adapter-init-core',
    entry: 'src/main/adapters/codex-cli/adapter-init-core.ts',
    external: [],
  },
  {
    name: 'codex-adapter-core',
    entry: 'src/main/adapters/codex-cli/adapter-core.ts',
    external: [],
  },
  {
    name: 'codex-generation-controller',
    entry: 'src/main/adapters/codex-cli/app-server/generation-operation.ts',
    external: [],
  },
  {
    name: 'codex-node-repl-browser-bootstrap',
    entry: 'src/main/adapters/codex-cli/app-server/node-repl-browser-bootstrap.ts',
    external: [],
  },
  {
    name: 'codex-mcp-startup-observer',
    entry: 'src/main/adapters/codex-cli/app-server/mcp-startup-observer.ts',
    external: [],
  },
  {
    name: 'codex-event-translator',
    entry: 'src/main/adapters/codex-cli/app-server/translate.ts',
    external: [],
  },
  {
    name: 'codex-thread-state-machine',
    entry: 'src/main/adapters/codex-cli/app-server/thread.ts',
    external: [],
  },
  {
    name: 'codex-client-diagnostics-port',
    entry: 'src/main/adapters/codex-cli/app-server/client-diagnostics-port.ts',
    external: [],
  },
  {
    name: 'codex-client-host-port',
    entry: 'src/main/adapters/codex-cli/app-server/client-host-port.ts',
    external: [],
  },
  {
    name: 'codex-app-server-client',
    entry: 'src/main/adapters/codex-cli/app-server/client.ts',
    external: [],
  },
  {
    name: 'checkpoint-backlog-worker-client',
    entry: 'src/main/session/continuation-context/checkpoint-backlog-worker-client.ts',
    external: [],
  },
  {
    name: 'checkpoint-background-worker-client',
    entry: 'src/main/session/continuation-context/checkpoint-background-worker-client.ts',
    external: [],
  },
  {
    name: 'storage-maintenance-scheduler',
    entry: 'src/main/store/storage-maintenance/scheduler.ts',
    external: [],
  },
  {
    name: 'adapter-registry-core',
    entry: 'src/main/adapters/registry-core.ts',
    external: [],
  },
  {
    name: 'provider-runtime-composition-core',
    entry: 'src/main/adapters/provider-runtime-core.ts',
    external: [],
  },
  {
    name: 'provider-adapter-context-core',
    entry: 'src/main/adapters/provider-adapter-context-core.ts',
    external: [],
  },
  {
    name: 'provider-adapter-set-core',
    entry: 'src/main/adapters/provider-adapter-set-core.ts',
    external: [],
  },
  {
    name: 'session-lifecycle-core',
    entry: 'src/main/session/manager/lifecycle-core.ts',
    external: [],
  },
  {
    name: 'session-manager-facade-core',
    entry: 'src/main/session/manager/facade-core.ts',
    external: [],
  },
  {
    name: 'session-creation-defaults-core',
    entry: 'src/main/adapters/session-creation-defaults-core.ts',
    external: [],
  },
  {
    name: 'codex-fork-target-runtime',
    entry: 'src/main/adapters/codex-cli/sdk-bridge/fork-session/target-runtime.ts',
    external: [],
  },
  {
    name: 'codex-create-runtime-selection',
    entry: 'src/main/adapters/codex-cli/sdk-bridge/create-session/runtime-selection.ts',
    external: [],
  },
  {
    name: 'codex-client-construction',
    entry: 'src/main/adapters/codex-cli/sdk-bridge/client-construction.ts',
    external: [],
  },
  {
    name: 'codex-gateway-profiles-core',
    entry: 'src/main/codex-config/gateway-profiles-core.ts',
    external: [],
  },
  {
    name: 'codex-agents-md-store',
    entry: 'src/main/codex-config/agents-md-store.ts',
    external: [],
  },
  {
    name: 'codex-skills-mirror-manifest',
    entry: 'src/main/codex-config/skills-mirror-manifest.ts',
    external: [],
  },
  {
    name: 'codex-skills-mirror-store',
    entry: 'src/main/codex-config/skills-mirror-store.ts',
    external: [],
  },
  {
    name: 'grok-binary-cache',
    entry: 'src/main/adapters/grok-build/resolve-grok-binary.ts',
    external: [],
  },
  {
    name: 'grok-resource-store',
    entry: 'src/main/adapters/grok-build/resource-store.ts',
    external: [],
  },
  {
    name: 'session-model-controller-core',
    entry: 'src/main/adapters/session-model-controller-core.ts',
    external: [],
  },
  {
    name: 'grok-summary-runner-core',
    entry: 'src/main/adapters/grok-build/summarizer-runner-core.ts',
    external: [],
  },
  {
    name: 'grok-adapter-host-core',
    entry: 'src/main/adapters/grok-build/adapter-host-core.ts',
    external: [],
  },
  {
    name: 'grok-aggregate-host-core',
    entry: 'src/main/adapters/grok-build/aggregate-host-core.ts',
    external: ['better-sqlite3'],
  },
  {
    name: 'grok-hook-installer-core',
    entry: 'src/main/adapters/grok-build/hook-installer.ts',
    external: [],
  },
  {
    name: 'grok-hook-routes-core',
    entry: 'src/main/adapters/grok-build/hook-routes.ts',
    external: [],
  },
  {
    name: 'grok-adapter-core',
    entry: 'src/main/adapters/grok-build/adapter-core.ts',
    external: [],
  },
  {
    name: 'grok-startup-registration-cleanup-core',
    entry: 'src/main/adapters/grok-build/startup-registration-cleanup.ts',
    external: [],
  },
  {
    name: 'claude-session-manager-port-core',
    entry: 'src/main/adapters/claude-code/session-manager-core.ts',
    external: [],
  },
  {
    name: 'grok-live-token-rate-core',
    entry: 'src/main/adapters/grok-build/live-token-rate-core.ts',
    external: [],
  },
  {
    name: 'codex-live-token-rate-core',
    entry: 'src/main/adapters/codex-cli/sdk-bridge/live-token-rate-core.ts',
    external: [],
  },
  {
    name: 'claude-live-token-rate-core',
    entry: 'src/main/adapters/claude-code/sdk-bridge/live-token-rate-core.ts',
    external: [],
  },
  {
    name: 'claude-runtime-metadata-core',
    entry: 'src/main/adapters/claude-code/sdk-bridge/runtime-metadata-core.ts',
    external: [],
  },
  {
    name: 'claude-context-usage-core',
    entry: 'src/main/adapters/claude-code/sdk-bridge/context-usage-core.ts',
    external: [],
  },
  {
    name: 'claude-message-translation-state-core',
    entry: 'src/main/adapters/claude-code/sdk-bridge/message-translation-state-core.ts',
    external: [],
  },
  {
    name: 'claude-message-file-changes-core',
    entry: 'src/main/adapters/claude-code/sdk-bridge/message-file-changes-core.ts',
    external: [],
  },
  {
    name: 'claude-sdk-message-translate-core',
    entry: 'src/main/adapters/claude-code/sdk-bridge/sdk-message-translate-core.ts',
    external: [],
  },
  {
    name: 'claude-stream-finalize-core',
    entry: 'src/main/adapters/claude-code/sdk-bridge/stream-finalize-core.ts',
    external: [],
  },
  {
    name: 'claude-stream-session-identity-core',
    entry: 'src/main/adapters/claude-code/sdk-bridge/stream-session-identity-core.ts',
    external: [],
  },
  {
    name: 'claude-stream-wait-core',
    entry: 'src/main/adapters/claude-code/sdk-bridge/stream-wait-core.ts',
    external: [],
  },
  {
    name: 'claude-stream-processor-core',
    entry: 'src/main/adapters/claude-code/sdk-bridge/stream-processor-core.ts',
    external: [],
  },
  {
    name: 'claude-final-result-usage-core',
    entry: 'src/main/adapters/claude-code/sdk-bridge/final-result-usage-core.ts',
    external: [],
  },
  {
    name: 'claude-session-defaults-core',
    entry: 'src/main/adapters/claude-code/sdk-bridge/session-defaults-core.ts',
    external: [],
  },
  {
    name: 'claude-session-lifecycle-core',
    entry: 'src/main/adapters/claude-code/sdk-bridge/session-lifecycle-core.ts',
    external: [],
  },
  {
    name: 'claude-sandbox-config-core',
    entry: 'src/main/adapters/claude-code/sandbox-config-core.ts',
    external: [],
  },
  {
    name: 'claude-settings-env-core',
    entry: 'src/main/adapters/claude-code/settings-env-core.ts',
    external: [],
  },
  {
    name: 'claude-hook-installer-core',
    entry: 'src/main/adapters/claude-code/hook-installer-core.ts',
    external: [],
  },
  {
    name: 'claude-pending-cancellation-core',
    entry: 'src/main/adapters/claude-code/sdk-bridge/pending-cancellation-core.ts',
    external: [],
  },
  {
    name: 'claude-message-controller-core',
    entry: 'src/main/adapters/claude-code/sdk-bridge/message-controller-core.ts',
    external: [],
  },
  {
    name: 'claude-pending-outgoing-core',
    entry: 'src/main/adapters/claude-code/sdk-bridge/pending-outgoing-core.ts',
    external: [],
  },
  {
    name: 'claude-query-options-builder-core',
    entry: 'src/main/adapters/claude-code/sdk-bridge/query-options-builder-core.ts',
    external: [],
  },
  {
    name: 'claude-can-use-tool-core',
    entry: 'src/main/adapters/claude-code/sdk-bridge/can-use-tool-core.ts',
    external: [],
  },
  {
    name: 'claude-cwd-transition-controller-core',
    entry: 'src/main/adapters/claude-code/sdk-bridge/cwd-transition-controller-core.ts',
    external: [],
  },
  {
    name: 'claude-gateway-sandbox-settings-core',
    entry:
      'src/main/adapters/claude-code/sdk-bridge/create-session/gateway-sandbox-settings-core.ts',
    external: [],
  },
  {
    name: 'claude-jsonl-discovery-core',
    entry: 'src/main/adapters/claude-code/sdk-bridge/recoverer/jsonl-discovery-core.ts',
    external: [],
  },
  {
    name: 'claude-user-message-stream-core',
    entry: 'src/main/adapters/claude-code/sdk-bridge/user-message-stream-core.ts',
    external: [],
  },
  {
    name: 'claude-user-message-acceptance-core',
    entry: 'src/main/adapters/claude-code/sdk-bridge/user-message-acceptance-core.ts',
    external: [],
  },
  {
    name: 'claude-permission-responder-core',
    entry: 'src/main/adapters/claude-code/sdk-bridge/permission-responder-core.ts',
    external: [],
  },
  {
    name: 'claude-session-finalize-core',
    entry: 'src/main/adapters/claude-code/sdk-bridge/session-finalize-core.ts',
    external: [],
  },
  {
    name: 'claude-fork-cleanup-core',
    entry: 'src/main/adapters/claude-code/fork-session-cleanup-core.ts',
    external: [],
  },
  {
    name: 'claude-native-fork-core',
    entry: 'src/main/adapters/claude-code/fork-session-core.ts',
    external: [],
  },
  {
    name: 'claude-gateway-profiles-core',
    entry: 'src/main/adapters/claude-code/gateway-profiles-core.ts',
    external: [],
  },
  {
    name: 'claude-gateway-fork-safety-core',
    entry: 'src/main/adapters/claude-code/gateway-fork-safety-core.ts',
    external: [],
  },
  {
    name: 'claude-sdk-runtime-core',
    entry: 'src/main/adapters/claude-code/sdk-runtime-core.ts',
    external: [],
  },
  {
    name: 'claude-usage-snapshot-core',
    entry: 'src/main/adapters/claude-code/usage-snapshot-core.ts',
    external: [],
  },
  {
    name: 'resource-placeholder-transformer',
    entry: 'src/main/utils/resources-placeholder-transformer.ts',
    external: [],
  },
  {
    name: 'browser-ownership-registry-core',
    entry: 'src/main/browser-use/engine/registry-core.ts',
    external: [],
  },
  {
    name: 'browser-tab-collection-core',
    entry: 'src/main/browser-use/engine/tab-collection-core.ts',
    external: [],
  },
  {
    name: 'codex-binary-layout',
    entry: 'src/main/adapters/codex-cli/sdk-bridge/codex-binary.ts',
    external: [],
  },
]);

const forbiddenPackages = new Set(['electron', 'electron-log']);
const violations = [];

function forbiddenPackage(specifier) {
  const packageName = specifier.startsWith('@')
    ? specifier.split('/').slice(0, 2).join('/')
    : specifier.split('/')[0];
  return forbiddenPackages.has(packageName);
}

for (const candidate of candidates) {
  await build({
    root: repoRoot,
    configFile: false,
    logLevel: 'silent',
    plugins: [{
      name: `core-node-boundary:${candidate.name}`,
      enforce: 'pre',
      resolveId(specifier, importer) {
        if (!forbiddenPackage(specifier)) return null;
        violations.push({
          candidate: candidate.name,
          importer: importer ?? '<entry>',
          specifier,
        });
        return { id: specifier, external: true };
      },
    }],
    resolve: { alias: aliases },
    ssr: { external: candidate.external },
    build: {
      ssr: true,
      target: 'node22',
      write: false,
      minify: false,
      rollupOptions: { input: resolve(repoRoot, candidate.entry) },
    },
  });
}

if (violations.length > 0) {
  console.error('[core-node-boundaries] failed');
  for (const violation of violations) {
    console.error(
      `- ${violation.candidate}: ${violation.importer} imports ${violation.specifier}`,
    );
  }
  process.exit(1);
}

console.log(`[core-node-boundaries] passed (${candidates.length} candidate)`);
