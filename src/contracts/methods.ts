import { AgentDeckCapability, type AgentDeckCapability as Capability } from './capabilities';
import type { JsonObject, JsonValue } from './json';
import type {
  ProjectListParams,
  ProjectListResult,
  ProjectResolveResult,
  SessionConsoleCreateParams,
  SessionConsoleCreateResult,
  SessionConsoleGetResult,
  SessionConsoleListParams,
  SessionConsoleListResult,
} from './session-console';

export interface SessionListItemDto {
  id: string;
  adapterId: string;
  cwd: string;
  title: string | null;
  status: string;
  createdAt: number;
  updatedAt: number;
}

export interface SessionHistoryEntryDto {
  id: string;
  sessionId: string;
  sequence: number;
  role: 'assistant' | 'system' | 'user';
  content: JsonValue;
  createdAt: number;
}

export interface PendingRequestDto {
  id: string;
  sessionId: string;
  kind: 'ask-user-question' | 'diff-review' | 'exit-plan' | 'permission';
  status: 'cancelled' | 'denied' | 'expired' | 'pending' | 'resolved' | 'stale';
  createdAt: number;
  expiresAt: number | null;
  display: JsonObject;
}

export interface SessionRuntimeControlsDto {
  adapterId: string;
  values: JsonObject;
  revision: number;
}

export type CoreMethodMap = {
  'system.health': {
    params: Record<string, never>;
    result: { ok: true; revision: number };
  };
  'session.list': {
    params: { includeArchived?: boolean };
    result: { sessions: SessionListItemDto[]; revision: number };
  };
  'session.get': {
    params: { sessionId: string };
    result: { session: SessionListItemDto | null; revision: number };
  };
  'session.create': {
    params: { adapterId: string; cwd: string; options: JsonObject };
    result: { sessionId: string; revision: number };
  };
  'session.console.list': {
    params: SessionConsoleListParams;
    result: SessionConsoleListResult;
  };
  'session.console.get': {
    params: { sessionId: string };
    result: SessionConsoleGetResult;
  };
  'project.list': {
    params: ProjectListParams;
    result: ProjectListResult;
  };
  'project.resolve': {
    params: { alias: string };
    result: ProjectResolveResult;
  };
  'session.console.create': {
    params: SessionConsoleCreateParams;
    result: SessionConsoleCreateResult;
  };
  'session.history': {
    params: { sessionId: string; cursor?: string; limit?: number };
    result: { entries: SessionHistoryEntryDto[]; nextCursor: string | null; revision: number };
  };
  'session.send': {
    params: { sessionId: string; text: string; attachments?: JsonObject[] };
    result: { messageId: string; sequence: number; revision: number };
  };
  'session.interrupt': {
    params: { sessionId: string };
    result: { accepted: boolean; revision: number };
  };
  'session.steer': {
    params: { sessionId: string; text: string };
    result: { accepted: boolean; revision: number };
  };
  'pending.list': {
    params: { sessionId: string };
    result: { requests: PendingRequestDto[]; revision: number };
  };
  'pending.respond': {
    params: { sessionId: string; requestId: string; action: string; value?: JsonValue };
    result: { status: Exclude<PendingRequestDto['status'], 'pending'>; revision: number };
  };
  'session.runtime.get': {
    params: { sessionId: string };
    result: SessionRuntimeControlsDto;
  };
  'session.runtime.update': {
    params: { sessionId: string; patch: JsonObject };
    result: {
      controls: SessionRuntimeControlsDto;
      effect: 'hot-applied' | 'handoff-required' | 'restart-required';
      replacementSessionId: string | null;
    };
  };
  'subscription.set': {
    params: { sessionId: string; subscribed: boolean };
    result: { subscribed: boolean; revision: number };
  };
};

export interface CoreMethodMetadata {
  capability: Capability;
  mutation: boolean;
  idempotency: 'forbidden' | 'required';
  expectedRevision: 'none' | 'optional' | 'required';
  feishu: 'none' | 'session-console';
}

const readMethod = (
  capability: Capability,
  feishu: CoreMethodMetadata['feishu'] = 'session-console',
): CoreMethodMetadata => ({
  capability,
  mutation: false,
  idempotency: 'forbidden',
  expectedRevision: 'none',
  feishu,
});

const mutationMethod = (
  capability: Capability,
  expectedRevision: CoreMethodMetadata['expectedRevision'] = 'optional',
  feishu: CoreMethodMetadata['feishu'] = 'session-console',
): CoreMethodMetadata => ({
  capability,
  mutation: true,
  idempotency: 'required',
  expectedRevision,
  feishu,
});

export const CORE_METHOD_METADATA = {
  'system.health': readMethod(AgentDeckCapability.SessionsRead, 'none'),
  'session.list': readMethod(AgentDeckCapability.SessionsRead, 'none'),
  'session.get': readMethod(AgentDeckCapability.SessionsRead, 'none'),
  'session.create': mutationMethod(AgentDeckCapability.SessionsWrite, 'optional', 'none'),
  'session.console.list': readMethod(AgentDeckCapability.SessionConsoleRead),
  'session.console.get': readMethod(AgentDeckCapability.SessionConsoleRead),
  'project.list': readMethod(AgentDeckCapability.ProjectsRead),
  'project.resolve': readMethod(AgentDeckCapability.ProjectsRead),
  'session.console.create': mutationMethod(AgentDeckCapability.SessionConsoleCreate),
  'session.history': readMethod(AgentDeckCapability.SessionHistory),
  'session.send': mutationMethod(AgentDeckCapability.SessionsWrite),
  'session.interrupt': mutationMethod(AgentDeckCapability.SessionsWrite),
  'session.steer': mutationMethod(AgentDeckCapability.SessionsWrite),
  'pending.list': readMethod(AgentDeckCapability.PendingRead),
  'pending.respond': mutationMethod(AgentDeckCapability.PendingRespond, 'required'),
  'session.runtime.get': readMethod(AgentDeckCapability.SessionRuntimeRead),
  'session.runtime.update': mutationMethod(
    AgentDeckCapability.SessionRuntimeWrite,
    'required',
  ),
  'subscription.set': mutationMethod(AgentDeckCapability.SubscriptionsWrite),
} as const satisfies Record<keyof CoreMethodMap, CoreMethodMetadata>;

export type CoreMethod = keyof CoreMethodMap;
