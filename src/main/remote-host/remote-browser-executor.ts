import { createHash } from 'node:crypto';

import {
  DESKTOP_BROKER_MAX_IMAGE_BASE64_BYTES,
  parseDesktopBrokerToolResult,
  type DesktopBrokerRequestDto,
  type DesktopBrokerToolResult,
} from '@contracts/index';
import {
  BROWSER_OPERATION_PROTOCOL_VERSION,
  browserOperationFromLegacyName,
  parseBrowserOperationArgs,
} from '@main/browser-use/operation-contract';
import { executeBrowserOperation } from '@main/browser-use/operation-executor';
import { acquireSessionBrowser } from '@main/browser-use/session-browser';

export function remoteBrowserOwnerId(input: {
  readonly profileId: string;
  readonly coreId: string;
  readonly generation: number | null;
  readonly sessionId: string;
}): string {
  const framed = [input.profileId, input.coreId, String(input.generation), input.sessionId]
    .map((value) => `${Buffer.byteLength(value)}:${value}`).join('|');
  return `remote-browser-${createHash('sha256').update(framed).digest('hex')}`;
}

function remoteUrlAllowed(value: unknown): boolean {
  if (typeof value !== 'string') return true;
  return !/^file:/i.test(value.trim());
}

function publicFailure(error: string, hint: string): DesktopBrokerToolResult {
  return parseDesktopBrokerToolResult({
    content: [{ type: 'text', text: JSON.stringify({ error, hint }) }],
    isError: true,
  });
}

async function sanitizeScreenshot(
  data: Record<string, unknown>,
  png: Buffer | undefined,
): Promise<DesktopBrokerToolResult> {
  if (png == null) {
    return publicFailure('Desktop screenshot response was invalid', 'Retry with a smaller maxWidth.');
  }
  const encoded = png.toString('base64');
  if (encoded.length > DESKTOP_BROKER_MAX_IMAGE_BASE64_BYTES) {
    return publicFailure(
      'Screenshot exceeded the remote inline transfer limit',
      'Retry with fullPage:false or a smaller maxWidth. Desktop paths are never exposed to Core.',
    );
  }
  return parseDesktopBrokerToolResult({
    content: [
      { type: 'text', text: JSON.stringify({ ...data, desktopArtifact: true }, null, 2) },
      { type: 'image', data: encoded, mimeType: 'image/png' },
    ],
  });
}

/** Executes one Core-authored browser request against a source-qualified desktop browser owner. */
export async function executeRemoteBrowserRequest(
  ownerId: string,
  request: DesktopBrokerRequestDto,
): Promise<DesktopBrokerToolResult> {
  const operation = browserOperationFromLegacyName(request.operation);
  let args: ReturnType<typeof parseBrowserOperationArgs>;
  try {
    args = parseBrowserOperationArgs(operation, request.args);
  } catch {
    return publicFailure('Remote browser arguments were rejected', 'Refresh the tool schema and retry.');
  }
  if (
    (operation === 'open' || operation === 'navigate') &&
    !remoteUrlAllowed((args as { url?: unknown }).url)
  ) {
    return publicFailure(
      'Remote browser cannot open desktop file URLs',
      'Use http, https, about, or a local development server URL instead.',
    );
  }
  const result = await executeBrowserOperation(
    { applicationSessionId: ownerId, handle: acquireSessionBrowser(ownerId) },
    {
      protocolVersion: BROWSER_OPERATION_PROTOCOL_VERSION,
      operation,
      args,
    } as never,
  );
  if (!result.ok) return publicFailure(result.error.message, result.error.nextAction);
  if (operation === 'screenshot') {
    return sanitizeScreenshot(result.data, result.binaryArtifacts[0]?.data);
  }
  try {
    return parseDesktopBrokerToolResult({
      content: [{ type: 'text', text: JSON.stringify(result.data, null, 2) }],
    });
  } catch {
    return publicFailure('Desktop browser response exceeded its safe boundary', 'Request less page data.');
  }
}
