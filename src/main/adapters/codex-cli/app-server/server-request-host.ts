import type { ChildProcessWithoutNullStreams } from 'node:child_process';

import type {
  CodexAppServerNotification,
  CodexAppServerServerRequest,
  CodexAppServerServerRequestHandler,
} from './protocol';

/**
 * Owns app-server initiated JSON-RPC request lifecycle independently from outbound RPCs.
 * A retired process can never write a late result into its replacement generation.
 */
export class CodexServerRequestHost {
  private handler: CodexAppServerServerRequestHandler | null = null;
  private readonly inbound = new Map<number | string, AbortController>();

  constructor(
    private readonly currentChild: () => ChildProcessWithoutNullStreams | null,
  ) {}

  setHandler(handler: CodexAppServerServerRequestHandler | null): void {
    this.handler = handler;
  }

  async handle(
    sourceChild: ChildProcessWithoutNullStreams,
    request: CodexAppServerServerRequest,
  ): Promise<void> {
    this.inbound.get(request.id)?.abort();
    const controller = new AbortController();
    this.inbound.set(request.id, controller);
    try {
      const disposition = this.handler
        ? await this.handler(request, controller.signal)
        : { handled: false as const };
      if (!this.isActive(sourceChild, controller)) return;
      if (!disposition.handled) {
        this.write(sourceChild, {
          id: request.id,
          error: {
            code: -32601,
            message: `Unsupported server request: ${request.method}`,
          },
        });
        return;
      }
      this.write(sourceChild, { id: request.id, result: disposition.result });
    } catch (error) {
      if (!this.isActive(sourceChild, controller)) return;
      this.write(sourceChild, {
        id: request.id,
        error: {
          code: -32000,
          message: error instanceof Error ? error.message : String(error),
        },
      });
    } finally {
      if (this.inbound.get(request.id) === controller) {
        this.inbound.delete(request.id);
      }
    }
  }

  observe(notification: CodexAppServerNotification): void {
    if (notification.method !== 'serverRequest/resolved') return;
    const requestId = readResolvedRequestId(notification.params);
    if (requestId !== null) this.abort(requestId);
  }

  abortAll(): void {
    const controllers = [...this.inbound.values()];
    this.inbound.clear();
    for (const controller of controllers) controller.abort();
  }

  private abort(id: number | string): void {
    const controller = this.inbound.get(id);
    if (!controller) return;
    this.inbound.delete(id);
    controller.abort();
  }

  private isActive(
    sourceChild: ChildProcessWithoutNullStreams,
    controller: AbortController,
  ): boolean {
    return !controller.signal.aborted && this.currentChild() === sourceChild;
  }

  private write(
    sourceChild: ChildProcessWithoutNullStreams,
    response: Record<string, unknown>,
  ): void {
    if (this.currentChild() !== sourceChild) return;
    try {
      sourceChild.stdin.write(`${JSON.stringify(response)}\n`);
    } catch {
      // The process may have exited while the host callback was resolving.
    }
  }
}

function readResolvedRequestId(params: unknown): number | string | null {
  if (!params || typeof params !== 'object' || Array.isArray(params)) return null;
  const requestId = (params as { requestId?: unknown }).requestId;
  return typeof requestId === 'number' || typeof requestId === 'string'
    ? requestId
    : null;
}
