import type { AccessContext } from './access';
import type { AuthoritativeCoreLocation, DeploymentTopology } from './topology';

export const AgentDeckCapability = {
  SessionsRead: 'sessions.read',
  SessionsWrite: 'sessions.write',
  SessionConsoleRead: 'session-console.read',
  SessionConsoleCreate: 'session-console.create',
  ProjectsRead: 'projects.read',
  SessionHistory: 'sessions.history',
  SessionSummariesRead: 'sessions.summaries.read',
  SessionFileChangesRead: 'sessions.file-changes.read',
  SessionRuntimeRead: 'sessions.runtime.read',
  SessionRuntimeWrite: 'sessions.runtime.write',
  SessionContextRead: 'sessions.context.read',
  SessionInputRead: 'sessions.input.read',
  SessionHandOff: 'sessions.handoff',
  PendingRead: 'pending.read',
  PendingRespond: 'pending.respond',
  PlanReview: 'plan-review',
  SubscriptionsWrite: 'subscriptions.write',
  Teams: 'teams',
  Usage: 'usage',
  NodeConfiguration: 'node.configuration',
  NodeAssets: 'node.assets',
  Tasks: 'tasks',
  Issues: 'issues',
  Files: 'files',
  Blobs: 'blobs',
  Browser: 'browser',
  Assets: 'assets',
  ProviderDiagnostics: 'providers.diagnostics',
  CredentialAdministration: 'credentials.admin',
  Replay: 'events.replay',
} as const;

export type AgentDeckCapability =
  (typeof AgentDeckCapability)[keyof typeof AgentDeckCapability];

export interface ProtocolVersion {
  major: number;
  minor: number;
}

export interface ClientHello {
  protocolVersion: ProtocolVersion;
  appVersion: string;
  clientId: string;
  requestedTopology: DeploymentTopology;
  lastEventRevision?: number;
}

export interface AuthoritativeCoreDescriptor {
  id: string;
  location: AuthoritativeCoreLocation;
  generation: number | null;
}

export interface AgentDeckTransportLimits {
  maxFrameBytes: number;
  maxBlobBytes: number;
  maxConcurrentRequests: number;
  maxQueuedEvents: number;
}

export interface HostHello {
  protocolVersion: ProtocolVersion;
  appVersion: string;
  topology: DeploymentTopology;
  instanceId: string;
  authoritativeCore: AuthoritativeCoreDescriptor;
  access: AccessContext;
  capabilities: readonly AgentDeckCapability[];
  limits: AgentDeckTransportLimits;
  eventRevision: number;
}
