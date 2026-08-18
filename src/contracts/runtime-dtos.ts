import type { JsonObject, JsonValue } from './json';

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
