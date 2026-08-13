import type { AppSettings } from '@shared/types';
import {
  ContinuationCheckpointRefreshService,
  setContinuationCheckpointRefreshService,
} from './checkpoint-refresh-service';
import { createDesktopCheckpointBacklogEstimator } from './checkpoint-backlog-worker-host';
import { openDesktopCheckpointBackgroundSource } from './checkpoint-background-worker-host';
import {
  refreshContinuationCheckpointWithDependencies,
} from './checkpoint-background-refresh';
import { getDb } from '@main/store/db';
import { CheckpointRefreshDiagnosticCoordinator } from './checkpoint-refresh-diagnostics';
import { resolveContinuationGeneratorSnapshot } from './resolver';
import { createCheckpointGeneratorRuntime } from './runtime';

/** Configure and start the Desktop host around the shared checkpoint scheduler/fold engine. */
export function startDesktopContinuationCheckpointRefreshService(
  settings: AppSettings,
): void {
  const service = new ContinuationCheckpointRefreshService(settings, {
    backlogEstimator: createDesktopCheckpointBacklogEstimator(getDb().name),
    diagnostics: new CheckpointRefreshDiagnosticCoordinator(),
    refresh: (input) => refreshContinuationCheckpointWithDependencies(input, {
      openBackgroundSource: openDesktopCheckpointBackgroundSource,
      resolveGenerator: resolveContinuationGeneratorSnapshot,
      generatorFactory: createCheckpointGeneratorRuntime,
    }),
  });
  setContinuationCheckpointRefreshService(service);
  service.start();
}
