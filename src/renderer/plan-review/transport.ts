import type { AgentEvent, PlanDeepReviewSession } from '@shared/types';

/** Source-owned operations consumed by the shared plan-review presentation. */
export interface PlanDeepReviewTransport {
  readonly identity: string;
  /** Changes whenever externally delivered child events may have advanced. */
  readonly revision: number;
  start(): Promise<PlanDeepReviewSession>;
  ask(question: string): Promise<void>;
  generateFeedback(): Promise<{ feedback: string }>;
  listEvents(sessionId: string): Promise<AgentEvent[]>;
}
