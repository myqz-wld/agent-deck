import type { RemoteHostMutationIntentDto, RemoteHostSessionTargetDto } from './types';

export interface RemoteHostPlanReviewTargetDto
  extends RemoteHostSessionTargetDto, RemoteHostMutationIntentDto {
  requestId: string;
  expectedRevision: number;
}

export interface RemoteHostPlanReviewAskDto extends RemoteHostPlanReviewTargetDto {
  question: string;
}

export interface RemoteHostPlanReviewSessionDto {
  sessionId: string;
  agentId: 'claude-code' | 'codex-cli' | 'grok-build';
  revision: number;
}

export interface RemoteHostPlanReviewAcceptedDto {
  accepted: true;
  revision: number;
}

export interface RemoteHostPlanReviewFeedbackDto {
  feedback: string;
  revision: number;
}
