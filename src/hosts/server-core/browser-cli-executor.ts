import {
  isJsonObject,
  type DesktopBrokerToolResult,
  type JsonObject,
} from '@contracts/index';
import type { BrowserCliBrokerExecutor } from '@main/browser-use/browser-cli-broker-core';
import {
  LEGACY_BROWSER_OPERATION_NAMES,
  browserOperationFailure,
  browserOperationSuccess,
  type BrowserOperation,
  type BrowserOperationArtifact,
  type BrowserOperationEnvelope,
} from '@main/browser-use/operation-contract';

import {
  ServerCoreDesktopBrokerError,
  type ServerCoreDesktopBrokerPort,
} from './desktop-broker-port';

export interface ServerCoreBrowserArtifactWriter {
  persist(input: {
    readonly applicationSessionId: string;
    readonly tabId: number;
    readonly png: Buffer;
  }): Promise<string>;
}

export interface ServerCoreBrowserCliExecutorOptions {
  readonly desktopBroker: Pick<ServerCoreDesktopBrokerPort, 'invoke'>;
  readonly artifacts: ServerCoreBrowserArtifactWriter;
}

function failure(
  operation: BrowserOperation,
  code: 'page_operation_failed' | 'transport_unavailable' | 'internal_error',
  message: string,
  retryable: boolean,
  nextAction: string,
): BrowserOperationEnvelope {
  return browserOperationFailure(operation, {
    code,
    message: message.slice(0, 512),
    retryable,
    nextAction: nextAction.slice(0, 512),
  });
}

function textPayload(result: DesktopBrokerToolResult): Record<string, unknown> | null {
  const block = result.content.find((candidate) => candidate.type === 'text');
  if (block?.type !== 'text') return null;
  try {
    const parsed: unknown = JSON.parse(block.text);
    return isJsonObject(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function publicBrokerFailure(
  operation: BrowserOperation,
  result: DesktopBrokerToolResult,
): BrowserOperationEnvelope {
  const payload = textPayload(result);
  const message = typeof payload?.error === 'string'
    ? payload.error
    : 'The connected desktop could not complete the Browser operation.';
  const nextAction = typeof payload?.hint === 'string'
    ? payload.hint
    : 'Inspect the connected desktop state, then retry once.';
  return failure(operation, 'page_operation_failed', message, true, nextAction);
}

function thrownFailure(
  operation: BrowserOperation,
  error: unknown,
): BrowserOperationEnvelope {
  if (error instanceof ServerCoreDesktopBrokerError) {
    const retryable = error.code === 'timeout' || error.code === 'limit' ||
      error.code === 'unavailable';
    return failure(
      operation,
      'transport_unavailable',
      'The connected desktop Browser bridge is unavailable.',
      retryable,
      retryable
        ? 'Keep a Browser-capable Agent Deck desktop connected, then retry.'
        : 'Restart the remote interactive session with its Browser skill enabled.',
    );
  }
  return failure(
    operation,
    'internal_error',
    'The remote Browser bridge failed internally.',
    true,
    'Inspect the current remote session and retry once.',
  );
}

async function success(
  operation: BrowserOperation,
  applicationSessionId: string,
  result: DesktopBrokerToolResult,
  artifacts: ServerCoreBrowserArtifactWriter,
): Promise<BrowserOperationEnvelope> {
  const data = textPayload(result);
  if (data == null) {
    return failure(
      operation,
      'internal_error',
      'The desktop Browser response was invalid.',
      true,
      'Retry the Browser operation once.',
    );
  }
  const projected: BrowserOperationArtifact[] = [];
  const images = result.content.filter((block) => block.type === 'image');
  if (images.length > 0) {
    const tabId = data.tabId;
    if (operation !== 'screenshot' || typeof tabId !== 'number' ||
        !Number.isSafeInteger(tabId) || tabId <= 0 || images.length !== 1) {
      return failure(
        operation,
        'internal_error',
        'The desktop Browser artifact metadata was invalid.',
        true,
        'Retry with a fresh Browser tab.',
      );
    }
    const png = Buffer.from(images[0]!.data, 'base64');
    if (png.byteLength === 0) {
      return failure(
        operation,
        'internal_error',
        'The desktop Browser screenshot was empty.',
        true,
        'Retry with a smaller screenshot size.',
      );
    }
    const path = await artifacts.persist({ applicationSessionId, tabId, png });
    projected.push({
      name: 'browser-screenshot.png',
      mimeType: 'image/png',
      bytes: png.byteLength,
      path,
    });
  }
  return browserOperationSuccess(operation, data, projected);
}

/** Converts the existing Core→Desktop broker result into the shared CLI v1 envelope. */
export function createServerCoreBrowserCliExecutor(
  options: ServerCoreBrowserCliExecutorOptions,
): BrowserCliBrokerExecutor {
  return async (binding, request) => {
    try {
      const result = await options.desktopBroker.invoke(
        binding.applicationSessionId,
        LEGACY_BROWSER_OPERATION_NAMES[request.operation],
        request.args as JsonObject,
      );
      if (result.isError === true) return publicBrokerFailure(request.operation, result);
      return await success(
        request.operation,
        binding.applicationSessionId,
        result,
        options.artifacts,
      );
    } catch (error) {
      return thrownFailure(request.operation, error);
    }
  };
}
