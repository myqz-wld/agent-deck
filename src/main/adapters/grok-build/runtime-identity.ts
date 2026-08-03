import type { ContextRuntimeIdentityEvidence } from '@shared/types';

import type { GrokRuntime } from './runtime-types';

export const GROK_NATIVE_RUNTIME_PROVIDER = 'native';

/** Build identity evidence only from a model id reported by the native ACP runtime. */
export function grokRuntimeIdentity(
  reportedModel: string | null | undefined,
): ContextRuntimeIdentityEvidence | null {
  const model = reportedModel?.trim() ?? '';
  return model
    ? { runtimeProvider: GROK_NATIVE_RUNTIME_PROVIDER, model }
    : null;
}

/**
 * Commit the model negotiated for one ACP session boundary.
 *
 * A requested override may be an alias. It remains the persisted user selection, but it cannot
 * identify a capacity observation unless ACP reports the effective model back. The initialize
 * default is attributable only when the session delegates model selection to that native default.
 */
export function applyGrokNegotiatedModel(
  runtime: GrokRuntime,
  reportedModel: string | null | undefined,
): void {
  const reportedIdentity = grokRuntimeIdentity(reportedModel);
  const delegatedDefaultIdentity = runtime.modelOverride === null
    ? grokRuntimeIdentity(runtime.nativeDefaultModel)
    : null;
  runtime.runtimeIdentity = reportedIdentity ?? delegatedDefaultIdentity;

  // Keep runtime.model's established requested-selection semantics. Session setup and token-ledger
  // labels continue using the persisted override, while capacity attribution uses runtimeIdentity.
  if (runtime.modelOverride === undefined) {
    runtime.model ??=
      reportedIdentity?.model ?? delegatedDefaultIdentity?.model ?? null;
    return;
  }
  runtime.model =
    runtime.modelOverride ?? reportedIdentity?.model ?? delegatedDefaultIdentity?.model ?? null;
}
