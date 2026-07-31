import type { CodexConfigObject } from '@main/codex-config/agent-deck-mcp-injector';

export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue | undefined };
export type JsonObject = { [key: string]: JsonValue | undefined };

export type CodexAppServerUserInput =
  | { type: 'text'; text: string; text_elements: JsonValue[] }
  | { type: 'image'; url: string; detail?: string }
  | { type: 'localImage'; path: string; detail?: string }
  | { type: 'skill'; name: string; path: string }
  | { type: 'mention'; name: string; path: string };

export interface CodexAppServerThreadTurn {
  id: string;
  status: 'completed' | 'interrupted' | 'failed' | 'inProgress';
  items: CodexAppServerThreadItem[];
}

export interface CodexAppServerThreadItem {
  type: string;
  id?: string;
  clientId?: string | null;
  content?: unknown;
  [key: string]: unknown;
}

export interface CodexAppServerThreadInfo {
  id: string;
  forkedFromId?: string | null;
  turns: CodexAppServerThreadTurn[];
  [key: string]: unknown;
}

export interface CodexAppServerThreadReadResult {
  thread: CodexAppServerThreadInfo;
}

export interface CodexAppServerThreadCreateResult {
  thread: CodexAppServerThreadInfo;
}

export type CodexAppServerNotification = { method: string; params?: unknown };

export interface CodexAppServerServerRequest {
  id: number | string;
  method: string;
  params?: unknown;
}

export type CodexAppServerServerRequestDisposition =
  | { handled: false }
  | { handled: true; result: unknown };

export type CodexAppServerServerRequestHandler = (
  request: CodexAppServerServerRequest,
  signal: AbortSignal,
) =>
  | CodexAppServerServerRequestDisposition
  | Promise<CodexAppServerServerRequestDisposition>;

export type CodexAppServerStreamEvent =
  | { type: 'thread.started'; thread_id: string }
  | { type: 'turn.accepted'; turn_id: string }
  | { type: 'server.notification'; notification: CodexAppServerNotification };

export interface CodexAppServerRunResult {
  finalResponse: string;
}

export interface CodexAppServerOptions {
  codexPathOverride?: string | null;
  /** Native `$CODEX_HOME/<name>.config.toml` profile selected at process startup. */
  profile?: string | null;
  config?: CodexConfigObject | null;
  env: Record<string, string>;
  cwd?: string;
  skillExtraRoots?: string[];
  /** Enable the in-app node_repl sandbox metadata compatibility bridge. */
  nodeReplSandboxMetaCompatibility?: boolean;
  /** Test/embedding override; production defaults to the app-server watchdog constant. */
  firstModelEventTimeoutMs?: number;
}

export interface JsonRpcResponse {
  id: number | string;
  result?: unknown;
  error?: { message?: string; code?: number; data?: unknown } | string;
}
