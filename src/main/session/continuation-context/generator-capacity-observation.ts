import { resolveContextRuntimeIdentity } from '@main/session/context-window/identity';
import type { ContextWindowCapacityService } from '@main/session/context-window/service';
import type {
  ContextWindowCapacityEvidence,
  SessionAdapterId,
} from '@shared/types';

/** Persist exact generator evidence for later work without mutating the frozen current snapshot. */
export function observeCheckpointGeneratorCapacity(input: {
  service: ContextWindowCapacityService;
  adapter: SessionAdapterId;
  evidence: ContextWindowCapacityEvidence | null;
  observedAt: number;
}): void {
  if (!input.evidence) return;
  const identity = resolveContextRuntimeIdentity({
    adapter: input.adapter,
    runtimeProvider: input.evidence.runtimeProvider,
    model: input.evidence.model,
    capacityConfigFingerprint: input.evidence.capacityConfigFingerprint,
  });
  if (identity.status !== 'concrete') return;
  input.service.observe({
    identity: identity.identity,
    windowTokens: input.evidence.windowTokens,
    source: input.evidence.source,
    observedAt: input.observedAt,
  });
}
