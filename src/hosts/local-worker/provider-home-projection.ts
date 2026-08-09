import { projectProviderHomeAuthFiles } from '@hosts/provider-state/provider-home-projection';

/** One-time terminal-owned projection into a freshly created Local Worker private root. */
export function projectLocalWorkerProviderHome(
  sourceHome: string,
  destinationHome: string,
): readonly string[] {
  return projectProviderHomeAuthFiles(sourceHome, destinationHome, 'create-only');
}
