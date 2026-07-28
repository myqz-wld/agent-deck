import type { AskUserQuestionRequest } from '@shared/types';

function questionFingerprint(
  question: AskUserQuestionRequest['questions'][number],
): string {
  return JSON.stringify([
    question.header ?? null,
    question.question,
    question.multiSelect ?? false,
    question.options.map((option) => [
      option.label,
      option.description ?? null,
    ]),
  ]);
}

/**
 * The provider schema has no question id, so drafts use the complete question
 * structure plus an occurrence number. Distinct questions keep their identity
 * when reordered, and duplicate text cannot overwrite another draft.
 */
export function askDraftKeys(
  request: AskUserQuestionRequest,
): string[] {
  const occurrences = new Map<string, number>();
  return request.questions.map((question) => {
    const fingerprint = questionFingerprint(question);
    const occurrence = occurrences.get(fingerprint) ?? 0;
    occurrences.set(fingerprint, occurrence + 1);
    return JSON.stringify([request.requestId, fingerprint, occurrence]);
  });
}
