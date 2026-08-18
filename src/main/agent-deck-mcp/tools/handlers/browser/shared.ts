/** MCP authentication and result projection for the provider-neutral Browser executor. */

import {
  executeBrowserOperation,
  type BrowserOperationExecutionResult,
  type ResolvedBrowserOperationOwner,
} from '@main/browser-use/operation-executor';
import {
  BROWSER_OPERATION_PROTOCOL_VERSION,
  LEGACY_BROWSER_OPERATION_NAMES,
  type BrowserOperation,
  type BrowserOperationArgsMap,
} from '@main/browser-use/operation-contract';
import { acquireSessionBrowser } from '@main/browser-use/session-browser';
import type { AgentDeckToolName } from '@main/agent-deck-mcp/types';

import {
  denyExternalIfNotAllowed,
  err,
  textContentOk,
  type HandlerContext,
  type HandlerResult,
} from '../../helpers';

export interface BrowserToolArgs {
  tabId?: number;
}

export type ResolvedMcpBrowserOwner = ResolvedBrowserOperationOwner;

function toolName(operation: BrowserOperation): AgentDeckToolName {
  return LEGACY_BROWSER_OPERATION_NAMES[operation] as AgentDeckToolName;
}

/** Resolve transport-authenticated caller identity before entering the shared executor. */
export function resolveOwner(
  operation: BrowserOperation,
  ctx: HandlerContext,
): ResolvedMcpBrowserOwner | HandlerResult {
  const denied = denyExternalIfNotAllowed(toolName(operation), ctx.caller);
  if (denied != null) return denied;
  const applicationSessionId = ctx.caller.callerSessionId;
  return {
    applicationSessionId,
    handle: acquireSessionBrowser(applicationSessionId),
  };
}

export function isHandlerResult(value: unknown): value is HandlerResult {
  return value != null && typeof value === 'object' && 'content' in value;
}

function mcpHint(nextAction: string): string {
  return nextAction
    .replace(/^Run agent-deck-browser /, 'Call browser_')
    .replace(/^Inspect the current tab state/, 'Call browser_tabs and inspect the current tab state');
}

export function projectBrowserExecution(result: BrowserOperationExecutionResult): HandlerResult {
  if (!result.ok) {
    return err(result.error.message, mcpHint(result.error.nextAction), {
      code: result.error.code,
      retryable: result.error.retryable,
    });
  }
  return textContentOk(result.data);
}

export async function executeMcpBrowserOperation<Operation extends BrowserOperation>(
  operation: Operation,
  args: BrowserOperationArgsMap[Operation],
  ctx: HandlerContext,
): Promise<HandlerResult> {
  const owner = resolveOwner(operation, ctx);
  if (isHandlerResult(owner)) return owner;
  const result = await executeBrowserOperation(owner, {
    protocolVersion: BROWSER_OPERATION_PROTOCOL_VERSION,
    operation,
    args,
  } as never);
  return projectBrowserExecution(result);
}

export { err };
