import type { AppView } from '@renderer/components/AppHeader';

export function clearDetailForSourceView(
  remoteMode: boolean,
  currentView: AppView,
  nextView: AppView,
  clearLocal: () => void,
  clearRemote: () => void,
): void {
  if (remoteMode) {
    if (nextView !== 'live' || currentView === 'history') clearRemote();
    return;
  }
  if (nextView === 'pending' || nextView === 'teams' ||
      nextView === 'issues' || nextView === 'data') clearLocal();
}
