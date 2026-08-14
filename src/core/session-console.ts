import {
  parseProjectListParams,
  parseProjectListResult,
  parseProjectResolveParams,
  parseProjectResolveResult,
  parseSessionConsoleCapabilitiesParams,
  parseSessionConsoleCapabilitiesResult,
  parseSessionConsoleCreateParams,
  parseSessionConsoleCreateResult,
  parseSessionConsoleGetParams,
  parseSessionConsoleGetResult,
  parseSessionConsoleListParams,
  parseSessionConsoleListResult,
  parseWorkspaceDirectoryListParams,
  parseWorkspaceDirectoryListResult,
  isCoreMethodGranted,
  type AccessContext,
  type CoreMethod,
  type ProjectListParams,
  type ProjectListResult,
  type ProjectResolveResult,
  type SessionConsoleCapabilitiesParams,
  type SessionConsoleCapabilitiesResult,
  type SessionConsoleCreateParams,
  type SessionConsoleCreateResult,
  type SessionConsoleGetResult,
  type SessionConsoleListParams,
  type SessionConsoleListResult,
  type WorkspaceDirectoryListParams,
  type WorkspaceDirectoryListResult,
} from '@contracts/index';

export const SESSION_CONSOLE_CORE_METHODS = Object.freeze([
  'project.list',
  'project.resolve',
  'session.console.capabilities',
  'session.console.create',
  'session.console.get',
  'session.console.list',
  'workspace.directory.list',
] as const satisfies readonly CoreMethod[]);

export type SessionConsoleCoreMethod = (typeof SESSION_CONSOLE_CORE_METHODS)[number];

export interface SessionConsoleExecutionContext {
  readonly access: AccessContext;
  readonly idempotencyKey: string | null;
  readonly expectedRevision: number | null;
  readonly deadlineAt: number | null;
  readonly signal: AbortSignal;
}

/**
 * Implemented beside the authoritative Core. Project refs are resolved inside this port; neither
 * the dispatcher nor a remote client receives a workspace path.
 */
export interface AuthoritativeSessionConsolePort {
  listSessions(
    params: SessionConsoleListParams,
    context: SessionConsoleExecutionContext,
  ): Promise<unknown> | unknown;
  getSession(
    params: { sessionId: string },
    context: SessionConsoleExecutionContext,
  ): Promise<unknown> | unknown;
  listProjects(
    params: ProjectListParams,
    context: SessionConsoleExecutionContext,
  ): Promise<unknown> | unknown;
  resolveProject(
    params: { alias: string },
    context: SessionConsoleExecutionContext,
  ): Promise<unknown> | unknown;
  getCapabilities(
    params: SessionConsoleCapabilitiesParams,
    context: SessionConsoleExecutionContext,
  ): Promise<unknown> | unknown;
  createSession(
    params: SessionConsoleCreateParams,
    context: SessionConsoleExecutionContext,
  ): Promise<unknown> | unknown;
  listWorkspaceDirectories(
    params: WorkspaceDirectoryListParams,
    context: SessionConsoleExecutionContext,
  ): Promise<unknown> | unknown;
}

export type SessionConsoleDispatchResult =
  | ProjectListResult
  | ProjectResolveResult
  | SessionConsoleCapabilitiesResult
  | SessionConsoleCreateResult
  | SessionConsoleGetResult
  | SessionConsoleListResult
  | WorkspaceDirectoryListResult;

export class SessionConsoleDispatchError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SessionConsoleDispatchError';
  }
}

function assertMutationContext(context: SessionConsoleExecutionContext): void {
  if (
    !context.idempotencyKey ||
    new TextEncoder().encode(context.idempotencyKey).byteLength > 512 ||
    /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/.test(context.idempotencyKey)
  ) {
    throw new SessionConsoleDispatchError(
      'session.console.create requires a stable idempotency key',
    );
  }
}

export function isSessionConsoleCoreMethod(value: string): value is SessionConsoleCoreMethod {
  return (SESSION_CONSOLE_CORE_METHODS as readonly string[]).includes(value);
}

/** Validates both sides of the cwd-free contract around an authoritative Core-owned port. */
export class SessionConsoleCoreDispatcher {
  constructor(private readonly authority: AuthoritativeSessionConsolePort) {}

  async execute(
    method: SessionConsoleCoreMethod,
    params: unknown,
    context: SessionConsoleExecutionContext,
  ): Promise<SessionConsoleDispatchResult> {
    if (!isCoreMethodGranted(context.access, method)) {
      throw new SessionConsoleDispatchError(
        `Access surface cannot invoke ${method}`,
      );
    }
    if (context.signal.aborted) {
      throw new SessionConsoleDispatchError('session-console request is already cancelled');
    }
    switch (method) {
      case 'session.console.list': {
        const parsed = parseSessionConsoleListParams(params);
        const result = await this.authority.listSessions(parsed, context);
        return parseSessionConsoleListResult(result, parsed.limit);
      }
      case 'session.console.get': {
        const parsed = parseSessionConsoleGetParams(params);
        return parseSessionConsoleGetResult(
          await this.authority.getSession(parsed, context),
          parsed.sessionId,
        );
      }
      case 'project.list': {
        const parsed = parseProjectListParams(params);
        const result = await this.authority.listProjects(parsed, context);
        return parseProjectListResult(result, parsed.limit);
      }
      case 'project.resolve': {
        const parsed = parseProjectResolveParams(params);
        return parseProjectResolveResult(
          await this.authority.resolveProject(parsed, context),
        );
      }
      case 'session.console.capabilities': {
        const parsed = parseSessionConsoleCapabilitiesParams(params);
        return parseSessionConsoleCapabilitiesResult(
          await this.authority.getCapabilities(parsed, context),
          parsed,
        );
      }
      case 'workspace.directory.list': {
        const parsed = parseWorkspaceDirectoryListParams(params);
        return parseWorkspaceDirectoryListResult(
          await this.authority.listWorkspaceDirectories(parsed, context),
          parsed.directory,
        );
      }
      case 'session.console.create': {
        assertMutationContext(context);
        const parsed = parseSessionConsoleCreateParams(params);
        return parseSessionConsoleCreateResult(
          await this.authority.createSession(parsed, context),
        );
      }
    }
  }
}
