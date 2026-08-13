import { Summarizer, type SummarizerSettingKey } from '.';
import { SummarizerDiagnosticCoordinator } from './logging';
import { settingsStore } from '@main/store/settings-store';
import { adapterRegistry } from '@main/adapters/registry';

/** Construct the Desktop host while keeping Electron-owned dependencies out of the Core engine. */
export function createDesktopSummarizer(): Summarizer {
  return new Summarizer({
    settings: { get: <K extends SummarizerSettingKey>(key: K) => settingsStore.get(key) },
    registry: adapterRegistry,
    diagnostics: new SummarizerDiagnosticCoordinator(),
  });
}

export const summarizer = createDesktopSummarizer();
