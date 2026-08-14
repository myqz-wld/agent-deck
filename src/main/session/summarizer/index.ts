import { adapterRegistry } from '@main/adapters/registry';
import { settingsStore } from '@main/store/settings-store';

import {
  Summarizer as SummarizerCore,
  type SummarizerDependencies as CoreSummarizerDependencies,
} from './core';
import { SummarizerDiagnosticCoordinator } from './logging';

export type {
  SummarizerDiagnosticsPort,
  SummarizerSettingKey,
} from './core';

/** Optional overrides for the current Desktop Summarizer facade. */
export type SummarizerDependencies =
  Omit<CoreSummarizerDependencies, 'registry' | 'settings'> & {
    readonly registry?: CoreSummarizerDependencies['registry'];
    readonly settings?: CoreSummarizerDependencies['settings'];
  };

/**
 * Desktop facade for callers and tests that construct `new Summarizer()`.
 * Electron-free hosts import `./core` and provide their own immutable settings and registry.
 */
export class Summarizer extends SummarizerCore {
  constructor(dependencies: SummarizerDependencies = {}) {
    super({
      ...dependencies,
      settings: dependencies.settings ?? settingsStore,
      registry: dependencies.registry ?? adapterRegistry,
      diagnostics: dependencies.diagnostics ?? new SummarizerDiagnosticCoordinator(),
    });
  }
}
