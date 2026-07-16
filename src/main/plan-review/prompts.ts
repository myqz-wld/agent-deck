import type { ExitPlanModeResponse } from '@shared/types';

const INTERNAL_MARKER_PREFIX = '<!-- agent-deck-plan-review-internal:';

export function buildPlanReviewForkPrompt(input: {
  requestId: string;
  plan: string;
  title?: string;
}): string {
  const titleLine = input.title?.trim() ? `Plan title: ${input.title.trim()}\n` : '';
  return `${INTERNAL_MARKER_PREFIX}setup:${input.requestId} -->
You are an isolated companion for reviewing the plan below. The user may ask questions about the
plan in this session. Use the inherited conversation as evidence, but treat the plan included here
as the current proposal.

Work read-mostly. Do not edit, create, delete, rename, or format files; do not run commands that
change repository or external state; and do not send cross-session messages. If the user explicitly
asks for a state-changing action, explain that this companion is for review and ask them to direct
the current plan-owning session in Agent Deck instead. You may use read-only inspection when it is
needed to answer a question. Keep answers focused on plan correctness, omissions, risks, trade-offs,
and validation. Match the user's language. Do not approve or submit feedback on the user's behalf.

${titleLine}Current plan:

${input.plan}

Reply briefly that the plan review is ready. Do not perform a full review until the user asks.`;
}

export function buildPlanReviewFeedbackDraftPrompt(input: {
  requestId: string;
  marker: string;
  plan: string;
}): string {
  return `${INTERNAL_MARKER_PREFIX}auto:${input.marker} -->
Using the inherited conversation and the current plan below, produce the revision feedback that
would be most useful to the current plan-owning session in Agent Deck. Identify only material gaps,
incorrect assumptions, missing user decisions, or validation/lifecycle risks. Preserve confirmed decisions.
Write a concise, directly actionable note in the user's language. Return only the feedback text;
do not preface it, approve the plan, edit files, or send any message yourself.

Current plan request: ${input.requestId}

${input.plan}`;
}

export function buildLatePlanDecisionPrompt(input: {
  title?: string;
  response: ExitPlanModeResponse;
}): string {
  const planLabel = input.title?.trim() ? ` “${input.title.trim()}”` : '';
  if (input.response.decision === 'keep-planning') {
    const feedback = input.response.feedback?.trim();
    return feedback
      ? `The user has now responded to the previously timed-out plan gate${planLabel}. Stop before implementation, revise the plan, and present it again. User feedback:\n\n${feedback}`
      : `The user has now asked you to continue revising the previously timed-out plan gate${planLabel}. Stop before implementation, clarify or improve the plan, and present it again.`;
  }
  return `The user has now approved the previously timed-out plan gate${planLabel}. Resume from that gate and continue with the approved plan. Treat this user turn as the authoritative late approval.`;
}

export function isInternalPlanReviewMessage(text: string): boolean {
  return text.startsWith(INTERNAL_MARKER_PREFIX);
}
