import {
  resolveClaudeGatewayProfile,
  type ResolvedClaudeGatewayProfile,
} from '@main/adapters/claude-code/gateway-profiles';
import type { AgentId } from '@main/adapters/options-builder';
import { runClaudeOneshot, runCodexOneshot } from '@main/session/oneshot-llm';
import { eventRepo } from '@main/store/event-repo';
import { sessionRepo } from '@main/store/session-repo';
import {
  isClaudeThinkingLevel,
  isCodexThinkingLevel,
} from '@shared/session-metadata';
import {
  NO_PLAN_REVIEW_DIALOGUE_FEEDBACK,
  type AgentEvent,
  type ExitPlanModeRequest,
  type SessionRecord,
} from '@shared/types';
import {
  buildPlanReviewFeedbackSynthesisPrompt,
  isInternalPlanReviewMessage,
  PLAN_REVIEW_FEEDBACK_SYSTEM_PROMPT,
} from './prompts';

const MAX_DIALOGUE_EVENTS = 400;
const MAX_DIALOGUE_CHARS = 36_000;
const MAX_FEEDBACK_CHARS = 20_000;
const FEEDBACK_TIMEOUT_MS = 5 * 60_000;
const NO_POST_FORK_DIALOGUE = '(No post-fork review dialogue.)';

interface DialogueMessage {
  role: 'user' | 'assistant';
  text: string;
}

export interface PlanReviewFeedbackSynthesisInput {
  runtimeSessionId: string;
  agentId: AgentId;
  /** Present only after the user has actually sent a question and created the review fork. */
  dialogueSessionId?: string;
  request: ExitPlanModeRequest;
  signal?: AbortSignal;
}

export interface PlanReviewFeedbackSynthesisDeps {
  getSession: (sessionId: string) => SessionRecord | null;
  listEvents: (sessionId: string, limit: number) => AgentEvent[];
  runClaude: typeof runClaudeOneshot;
  runCodex: typeof runCodexOneshot;
  resolveClaudeGateway: (
    provider: string | null | undefined,
  ) => ResolvedClaudeGatewayProfile | null;
}

const defaultDeps: PlanReviewFeedbackSynthesisDeps = {
  getSession: (sessionId) => sessionRepo.get(sessionId),
  listEvents: (sessionId, limit) => eventRepo.listForSession(sessionId, limit),
  runClaude: runClaudeOneshot,
  runCodex: runCodexOneshot,
  resolveClaudeGateway: resolveClaudeGatewayProfile,
};

function messageFromEvent(event: AgentEvent): DialogueMessage | null {
  if (event.kind !== 'message') return null;
  const payload = event.payload as {
    role?: unknown;
    text?: unknown;
    error?: unknown;
  } | null;
  if (
    (payload?.role !== 'user' && payload?.role !== 'assistant') ||
    typeof payload.text !== 'string' ||
    payload.error === true
  ) return null;
  const text = payload.text.trim();
  if (!text || isInternalPlanReviewMessage(text)) return null;
  return { role: payload.role, text };
}

/** Keep only discussion created after the fork's internal setup turn, bounded from the recent end. */
export function buildPostForkReviewDialogue(eventsNewestFirst: AgentEvent[]): string {
  const chronological = [...eventsNewestFirst].reverse();
  const messages: DialogueMessage[] = [];
  let discussionStarted = false;
  for (const event of chronological) {
    const message = messageFromEvent(event);
    if (!message) continue;
    if (!discussionStarted) {
      if (message.role !== 'user') continue;
      discussionStarted = true;
    }
    messages.push(message);
  }
  if (messages.length === 0) return NO_POST_FORK_DIALOGUE;

  const retained: string[] = [];
  let chars = 0;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]!;
    const block = `${message.role === 'user' ? 'User' : 'Reviewer'}:\n${message.text}`;
    if (retained.length > 0 && chars + block.length > MAX_DIALOGUE_CHARS) break;
    retained.unshift(block);
    chars += block.length;
  }
  while (retained[0]?.startsWith('Reviewer:\n')) retained.shift();
  return retained.length > 0 ? retained.join('\n\n') : NO_POST_FORK_DIALOGUE;
}

export async function synthesizePlanReviewFeedback(
  input: PlanReviewFeedbackSynthesisInput,
  deps: PlanReviewFeedbackSynthesisDeps = defaultDeps,
): Promise<string> {
  if (!input.dialogueSessionId) return NO_PLAN_REVIEW_DIALOGUE_FEEDBACK;
  const dialogue = buildPostForkReviewDialogue(
    deps.listEvents(input.dialogueSessionId, MAX_DIALOGUE_EVENTS),
  );
  // A child can exist even when its first question failed before provider consumption. Keep the
  // no-dialogue path resource-free instead of treating the setup/readiness messages as evidence.
  if (dialogue === NO_POST_FORK_DIALOGUE) return NO_PLAN_REVIEW_DIALOGUE_FEEDBACK;
  const session = deps.getSession(input.runtimeSessionId);
  if (!session || session.agentId !== input.agentId) {
    throw new Error('审阅会话不可用，无法生成计划意见。');
  }
  const prompt = buildPlanReviewFeedbackSynthesisPrompt({
    requestId: input.request.requestId,
    plan: input.request.plan,
    dialogue,
    ...(input.request.title ? { title: input.request.title } : {}),
  });
  const common = {
    cwd: session.cwd,
    prompt,
    systemPrompt: PLAN_REVIEW_FEEDBACK_SYSTEM_PROMPT,
    timeoutMs: FEEDBACK_TIMEOUT_MS,
    timeoutErrorMessage: '生成计划意见超时，请重试或手动提交意见。',
    ...(input.signal ? { signal: input.signal } : {}),
  };
  let raw: string;
  if (input.agentId === 'codex-cli') {
    raw = await deps.runCodex({
      ...common,
      ...(session.model ? { model: session.model } : {}),
      ...(session.runtimeProvider
        ? { provider: session.runtimeProvider }
        : {}),
      ...(isCodexThinkingLevel(session.thinking)
        ? { modelReasoningEffort: session.thinking }
        : {}),
    });
  } else {
    const profile = deps.resolveClaudeGateway(session.runtimeProvider);
    raw = await deps.runClaude({
      ...common,
      ...(session.model ? { model: session.model } : {}),
      ...(isClaudeThinkingLevel(session.thinking) ? { effort: session.thinking } : {}),
      ...(profile ? { settingsPath: profile.settingsPath } : {}),
    });
  }
  const feedback = raw.trim().slice(0, MAX_FEEDBACK_CHARS);
  if (!feedback) throw new Error('独立审阅会话没有生成可提交的意见。');
  return feedback;
}
