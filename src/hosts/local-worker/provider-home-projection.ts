import {
  projectProviderHomeFiles,
  syncProviderHomeFiles,
} from '@hosts/provider-state/provider-home-projection';

/** One-time terminal-owned projection into a freshly created Local Worker private root. */
export function projectLocalWorkerProviderHome(
  sourceHome: string,
  destinationHome: string,
): readonly string[] {
  return projectProviderHomeFiles(sourceHome, destinationHome, 'create-only');
}

/** Refreshes provider definitions and their safe catalog before a Worker restart. */
export function syncLocalWorkerProviderHome(
  sourceHome: string,
  destinationHome: string,
): readonly string[] {
  return syncProviderHomeFiles(sourceHome, destinationHome);
}
