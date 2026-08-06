import type { AgentEvent } from '@shared/types';
import type {
  AdapterContext,
  AdapterHookServerPort,
  AdapterRouteRegistryPort,
} from './types/adapter-context';

export interface ProviderAdapterContextInput {
  readonly hookServer: AdapterHookServerPort;
  readonly routeRegistry: AdapterRouteRegistryPort;
  readonly emit: (event: AgentEvent) => void;
  readonly paths: AdapterContext['paths'];
}

/**
 * Creates the immutable provider-composition envelope without discovering desktop state.
 * Live listener/registry ports retain their identity; only path values are snapshotted.
 */
export function createProviderAdapterContext(
  input: ProviderAdapterContextInput,
): AdapterContext {
  return Object.freeze({
    hookServer: input.hookServer,
    routeRegistry: input.routeRegistry,
    emit: input.emit,
    paths: Object.freeze({ ...input.paths }),
  });
}
