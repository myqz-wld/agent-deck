import {
  AgentDeckCapability,
  type AgentDeckCapability as Capability,
} from '@contracts/index';
import type { AppView } from './components/AppHeader';

interface AppViewDescriptor {
  view: AppView;
  label: string;
  remoteCapability: Capability | null;
}

export const APP_VIEW_CATALOG: readonly AppViewDescriptor[] = Object.freeze([
  { view: 'live', label: '实时', remoteCapability: AgentDeckCapability.SessionPresentationRead },
  { view: 'pending', label: '待处理', remoteCapability: AgentDeckCapability.PendingIndexRead },
  { view: 'history', label: '历史', remoteCapability: AgentDeckCapability.SessionPresentationRead },
  { view: 'issues', label: '问题', remoteCapability: AgentDeckCapability.Issues },
  { view: 'data', label: '数据', remoteCapability: AgentDeckCapability.Usage },
]);

export function availableAppViews(
  remote: boolean,
  capabilities: ReadonlySet<string>,
): readonly AppViewDescriptor[] {
  return APP_VIEW_CATALOG.filter((entry) =>
    !remote || entry.remoteCapability === null || capabilities.has(entry.remoteCapability));
}

export function isAppViewAvailable(
  view: AppView,
  remote: boolean,
  capabilities: ReadonlySet<string>,
): boolean {
  return availableAppViews(remote, capabilities).some((entry) => entry.view === view);
}

export function appViewLabel(entry: AppViewDescriptor): string {
  return entry.label;
}
