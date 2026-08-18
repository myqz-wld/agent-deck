import { createHash } from 'node:crypto';

import { persistBrowserScreenshot } from './screenshot-store';
import { acquireSessionBrowser } from './session-browser';
import {
  startBrowserCliBrokerCore,
  type BrowserCliBrokerExecutor,
  type BrowserCliBrokerHandle,
} from './browser-cli-broker-core';
import {
  browserOperationFailure,
  browserOperationSuccess,
  type BrowserOperationArtifact,
  type BrowserOperationEnvelope,
} from './operation-contract';
import { executeBrowserOperation } from './operation-executor';
import type { BrowserLeaseRegistryCore } from './browser-lease-registry-core';
import { getBrowserLeaseRegistry } from './browser-lease-registry';

export type { BrowserCliBrokerExecutor, BrowserCliBrokerHandle } from './browser-cli-broker-core';
export { defaultBrowserCliBrokerPath } from './browser-cli-broker-core';

export interface BrowserCliBrokerOptions {
  readonly pipePath?: string;
  readonly registry?: BrowserLeaseRegistryCore;
  readonly persistScreenshot?: typeof persistBrowserScreenshot;
  readonly execute?: BrowserCliBrokerExecutor;
  readonly onError?: (error: unknown) => void;
}

function safeExecutionFailure(
  result: Extract<BrowserOperationEnvelope, { ok: false }>,
): BrowserOperationEnvelope {
  const messages = {
    stale_ref: 'The Browser element reference is stale.',
    operation_timeout: 'The Browser operation reached its timeout.',
    page_operation_failed: 'The Browser page operation failed.',
    internal_error: 'The Browser operation failed internally.',
  } as const;
  return browserOperationFailure(result.operation, {
    ...result.error,
    message: messages[result.error.code as keyof typeof messages] ?? result.error.message.slice(0, 512),
  });
}

function artifactScope(binding: {
  readonly adapterId: string;
  readonly runtimeGeneration: number;
  readonly sourceIdentity: string;
}): string {
  const framed = [binding.adapterId, String(binding.runtimeGeneration), binding.sourceIdentity]
    .map((value) => `${Buffer.byteLength(value)}:${value}`).join('|');
  return `cli-${createHash('sha256').update(framed).digest('hex').slice(0, 24)}`;
}

function localExecutor(
  persist: typeof persistBrowserScreenshot,
): BrowserCliBrokerExecutor {
  return async (binding, request) => {
    const execution = await executeBrowserOperation({
      applicationSessionId: binding.applicationSessionId,
      handle: acquireSessionBrowser(binding.applicationSessionId),
      projectionSource: { kind: 'local', sessionId: binding.applicationSessionId },
    }, request);
    if (!execution.ok) return safeExecutionFailure(execution);
    const artifacts: BrowserOperationArtifact[] = [];
    for (const artifact of execution.binaryArtifacts) {
      const tabId = execution.data.tabId;
      if (typeof tabId !== 'number') {
        return browserOperationFailure(request.operation, {
          code: 'internal_error',
          message: 'Browser artifact metadata was invalid.',
          retryable: true,
          nextAction: 'Close and reopen the Browser tab.',
        });
      }
      const path = await persist(artifactScope(binding), tabId, artifact.data);
      artifacts.push({
        name: artifact.name,
        mimeType: artifact.mimeType,
        bytes: artifact.data.byteLength,
        path,
      });
    }
    return browserOperationSuccess(request.operation, execution.data, artifacts);
  };
}

export function startBrowserCliBroker(
  options: BrowserCliBrokerOptions = {},
): Promise<BrowserCliBrokerHandle> {
  const registry = options.registry ?? getBrowserLeaseRegistry();
  return startBrowserCliBrokerCore({
    registry,
    execute: options.execute ?? localExecutor(
      options.persistScreenshot ?? persistBrowserScreenshot,
    ),
    ...(options.pipePath === undefined ? {} : { pipePath: options.pipePath }),
    ...(options.onError === undefined ? {} : { onError: options.onError }),
  });
}
