import {
  AgentDeckClientErrorCode,
  isJsonValue,
  isCoreMethodAllowed,
  parseNodeAssetContentParams,
  parseNodeAssetConventionParams,
  parseNodeAssetListParams,
  type CoreMethod,
} from '@contracts/index';
import {
  DaemonRequestError,
  type DaemonCoreRuntime,
  type DaemonEventSubscriptionInput,
  type DaemonRequestInput,
  type DaemonRequestResult,
} from '@hosts/daemon';

import { ServerCoreNodeAssetCatalog } from './node-asset-catalog';

export const SERVER_CORE_NODE_ASSET_METHODS = Object.freeze([
  'node.assets.list',
  'node.assets.content',
  'node.assets.convention',
] as const satisfies readonly CoreMethod[]);

type NodeAssetMethod = (typeof SERVER_CORE_NODE_ASSET_METHODS)[number];

function isNodeAssetMethod(method: CoreMethod): method is NodeAssetMethod {
  return (SERVER_CORE_NODE_ASSET_METHODS as readonly CoreMethod[]).includes(method);
}

/** Desktop-only reads over the exact assets and conventions owned by this Worker/Core. */
export class ServerCoreNodeAssetRuntime implements DaemonCoreRuntime {
  readonly supportedMethods: readonly CoreMethod[];
  readonly subscribe?: DaemonCoreRuntime['subscribe'];

  constructor(
    private readonly base: DaemonCoreRuntime,
    private readonly catalog: ServerCoreNodeAssetCatalog,
    private readonly currentMetadataRevision: () => number,
  ) {
    this.supportedMethods = Object.freeze([
      ...new Set([...base.supportedMethods, ...SERVER_CORE_NODE_ASSET_METHODS]),
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
    if (!isNodeAssetMethod(input.method)) return this.base.execute(input);
    if (!isCoreMethodAllowed(input.access.surface, input.method)) {
      throw new DaemonRequestError(AgentDeckClientErrorCode.AccessDenied, 'Request rejected');
    }
    if (input.signal.aborted) {
      throw new DaemonRequestError(AgentDeckClientErrorCode.Cancelled, 'Request was cancelled');
    }
    const revision = this.currentMetadataRevision();
    try {
      if (input.method === 'node.assets.list') {
        parseNodeAssetListParams(input.params);
        return this.result(this.catalog.list(revision), revision);
      }
      if (input.method === 'node.assets.content') {
        const result = this.catalog.content(parseNodeAssetContentParams(input.params), revision);
        if (!result) {
          throw new DaemonRequestError(AgentDeckClientErrorCode.NotFound, 'Worker asset not found');
        }
        return this.result(result, revision);
      }
      const params = parseNodeAssetConventionParams(input.params);
      return this.result(this.catalog.convention(params.adapterId, revision), revision);
    } catch (error) {
      if (error instanceof DaemonRequestError) throw error;
      throw new DaemonRequestError(AgentDeckClientErrorCode.InvalidRequest, 'Request rejected');
    }
  }

  private result(value: unknown, revision: number): DaemonRequestResult {
    if (!isJsonValue(value)) throw new Error('Node asset result is not JSON-safe');
    return { result: value, revision };
  }
}
