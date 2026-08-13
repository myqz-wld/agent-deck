import {
  projectProviderHomeFiles,
  syncProviderHomeFiles,
} from '@hosts/provider-state/provider-home-projection';
import { projectLocalWorkerAssets } from './provider-asset-projection';
import { projectLocalWorkerDesktopState } from './desktop-state-projection';

/** One-time terminal-owned projection into a freshly created Local Worker private root. */
export function projectLocalWorkerProviderHome(
  sourceHome: string,
  destinationHome: string,
): readonly string[] {
  return Object.freeze([
    ...projectProviderHomeFiles(sourceHome, destinationHome, 'create-only'),
    ...projectLocalWorkerAssets(sourceHome, destinationHome, 'create-only'),
    ...projectLocalWorkerDesktopState(sourceHome, destinationHome, 'create-only'),
  ]);
}

/** Refreshes provider definitions and their safe catalog before a Worker restart. */
export function syncLocalWorkerProviderHome(
  sourceHome: string,
  destinationHome: string,
): readonly string[] {
  return Object.freeze([
    ...syncProviderHomeFiles(sourceHome, destinationHome),
    ...projectLocalWorkerAssets(sourceHome, destinationHome, 'replace'),
    ...projectLocalWorkerDesktopState(sourceHome, destinationHome, 'replace'),
  ]);
}
