import type { CodexConfigObject } from '@main/codex-config/agent-deck-mcp-injector';

export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue | undefined };
export type JsonObject = { [key: string]: JsonValue | undefined };

export type CodexAppServerUserInput =
  | { type: 'text'; text: string; text_elements: JsonValue[] }
  | { type: 'localImage'; path: string; detail?: string };

export type CodexAppServerNotification = { method: string; params?: unknown };

export type CodexAppServerStreamEvent =
  | { type: 'thread.started'; thread_id: string }
  | { type: 'server.notification'; notification: CodexAppServerNotification };

export interface CodexAppServerRunResult {
  finalResponse: string;
}

export interface CodexAppServerOptions {
  codexPathOverride?: string | null;
  config?: CodexConfigObject | null;
  env: Record<string, string>;
  cwd?: string;
  skillExtraRoots?: string[];
}

export interface JsonRpcResponse {
  id: number | string;
  result?: unknown;
  error?: { message?: string; code?: number; data?: unknown } | string;
}
