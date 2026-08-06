import { join } from 'node:path';
import type { CodexConfigObject } from '@main/codex-config/agent-deck-mcp-injector';
import log from '@main/utils/logger';
import { resolveAgentDeckResourcesRoot } from '@main/utils/resources-placeholder';
import { safeErrorSummary } from '@main/utils/safe-diagnostic';
import type { CodexThreadOptions } from '../sdk-bridge/thread-options-builder';
import type { CodexAppServerClient, CodexGenerationOperation } from './client';
import {
  NODE_REPL_BROWSER_PROXY_FILENAME,
  prepareNodeReplBrowserBootstrapPolicy,
  type NodeReplBrowserBootstrapDiagnostic,
} from './node-repl-browser-bootstrap';

const logger = log.scope('codex-node-repl-browser');

/** Electron-main adapter for the otherwise host-neutral node_repl Browser bootstrap policy. */
export function prepareNodeReplBrowserBootstrap(
  client: CodexAppServerClient,
  options: CodexThreadOptions,
  baseConfig: CodexConfigObject | null,
  operation?: CodexGenerationOperation,
): Promise<CodexThreadOptions> {
  return prepareNodeReplBrowserBootstrapPolicy(
    client,
    options,
    baseConfig,
    {
      executablePath: process.execPath,
      proxyPath: join(
        resolveAgentDeckResourcesRoot(),
        'bin',
        NODE_REPL_BROWSER_PROXY_FILENAME,
      ),
      diagnose: diagnoseNodeReplBrowserBootstrap,
    },
    operation,
  );
}

function diagnoseNodeReplBrowserBootstrap(
  diagnostic: NodeReplBrowserBootstrapDiagnostic,
): void {
  if (diagnostic.type === 'installed') {
    logger.debug('[node-repl-browser] installed Browser process bootstrap for node_repl');
    return;
  }
  logger.warn(
    '[node-repl-browser] config/read failed; leaving node_repl unchanged',
    safeErrorSummary(diagnostic.error),
  );
}
