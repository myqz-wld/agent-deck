import {
  AgentDeckClientErrorCode,
  isCoreMethodAllowed,
  parseWorkspaceDirectoryCreateParams,
  parseWorkspaceDirectoryCreateResult,
  type CoreMethod,
  type JsonValue,
} from '@contracts/index';
import {
  DaemonRequestError,
  type DaemonCoreRuntime,
  type DaemonEventSubscriptionInput,
  type DaemonRequestInput,
  type DaemonRequestResult,
} from '@hosts/daemon';

import {
  claimServerCoreMutation,
  completeServerCoreMutation,
  releaseServerCoreMutation,
  type ServerCoreMutationLedgerPort,
} from './runtime-mutation-ledger';
import { createServerCoreWorkspaceDirectory } from './workspace-directory-create';

export const SERVER_CORE_WORKSPACE_DIRECTORY_MUTATION_METHODS = Object.freeze([
  'workspace.directory.create',
] as const satisfies readonly CoreMethod[]);

export interface ServerCoreWorkspaceDirectoryMutationRuntimeOptions {
  readonly workspaceRoot: string;
  readonly metadata: ServerCoreMutationLedgerPort & {
    appendChange(kind: string, entityId: string | null, payload: JsonValue): number;
  };
}

/** Desktop-only Workspace mutation; no absolute path crosses the contract. */
export class ServerCoreWorkspaceDirectoryMutationRuntime implements DaemonCoreRuntime {
  readonly supportedMethods: readonly CoreMethod[];
  readonly subscribe?: DaemonCoreRuntime['subscribe'];

  constructor(
    private readonly base: DaemonCoreRuntime,
    private readonly options: ServerCoreWorkspaceDirectoryMutationRuntimeOptions,
  ) {
    this.supportedMethods = Object.freeze([
      ...new Set([...base.supportedMethods, ...SERVER_CORE_WORKSPACE_DIRECTORY_MUTATION_METHODS]),
    ]);
    if (base.subscribe) {
      const subscribe = base.subscribe.bind(base);
      this.subscribe = (input: DaemonEventSubscriptionInput) => subscribe(input);
    }
  }

  start(): Promise<void> { return this.base.start(); }
  stop(reason: string): Promise<void> { return this.base.stop(reason); }
  currentRevision(...args: Parameters<DaemonCoreRuntime['currentRevision']>): Promise<number> | number {
    return this.base.currentRevision(...args);
  }

  async execute(input: DaemonRequestInput): Promise<DaemonRequestResult> {
    if (input.method !== 'workspace.directory.create') return this.base.execute(input);
    if (!isCoreMethodAllowed(input.access.surface, input.method)) {
      throw new DaemonRequestError(AgentDeckClientErrorCode.AccessDenied, 'Request rejected');
    }
    if (input.signal.aborted) {
      throw new DaemonRequestError(AgentDeckClientErrorCode.Cancelled, 'Request was cancelled');
    }
    const params = parseWorkspaceDirectoryCreateParams(input.params);
    const claim = claimServerCoreMutation(input, this.options.metadata);
    if (claim.replay) return claim.replay;
    let created = false;
    try {
      const directory = createServerCoreWorkspaceDirectory(params, this.options.workspaceRoot);
      created = true;
      const revision = this.options.metadata.appendChange(
        'workspace.directory.created',
        directory,
        { directory },
      );
      const result = parseWorkspaceDirectoryCreateResult({ directory, revision }, params);
      return completeServerCoreMutation(claim, this.options.metadata, result, revision);
    } catch (cause) {
      if (created) throw cause;
      const code = (cause as NodeJS.ErrnoException | null)?.code;
      const safe = new DaemonRequestError(
        code === 'EEXIST' ? AgentDeckClientErrorCode.Conflict : AgentDeckClientErrorCode.InvalidRequest,
        code === 'EEXIST' ? 'Directory already exists' : 'Workspace directory could not be created',
      );
      return releaseServerCoreMutation(claim, this.options.metadata, safe);
    }
  }
}
