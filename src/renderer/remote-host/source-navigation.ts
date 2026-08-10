import type { AppView } from '@renderer/components/AppHeader';

export function clearDetailForSourceView(
  remoteMode: boolean,
  nextView: AppView,
  clearLocal: () => void,
  clearRemote: () => void,
): void {
  if (remoteMode) {
    if (nextView !== 'live') clearRemote();
    return;
  }
  if (nextView === 'pending' || nextView === 'teams' ||
      nextView === 'issues' || nextView === 'data') clearLocal();
}
