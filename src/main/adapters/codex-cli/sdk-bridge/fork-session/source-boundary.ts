import type {
  CodexAppServerThreadReadResult,
  CodexAppServerUserInput,
} from '../../app-server/protocol';

export interface CodexForkBoundary {
  currentUserInputs: CodexAppServerUserInput[];
  lastTerminalTurnId: string | null;
}

const TERMINAL_TURN_STATUSES = new Set(['completed', 'interrupted', 'failed']);

export function selectCodexForkBoundary(
  source: CodexAppServerThreadReadResult,
): CodexForkBoundary {
  const turns = source.thread.turns;
  const activeIndex = turns.findLastIndex((turn) => turn.status === 'inProgress');
  if (activeIndex < 0) {
    throw new Error(
      'Codex native fork requires the caller to have an in-progress turn. Retry while the source request is active or use contextMode "fresh".',
    );
  }
  if (activeIndex !== turns.length - 1) {
    throw new Error(
      'Codex returned an inconsistent active-turn order, so a safe fork boundary could not be selected. Use contextMode "fresh".',
    );
  }

  const currentUserInputs = turns[activeIndex].items.flatMap((item) => {
    if (item.type !== 'userMessage' || !Array.isArray(item.content)) return [];
    return (item.content as CodexAppServerUserInput[]).map(cloneUserInput);
  });
  if (currentUserInputs.length === 0) {
    throw new Error(
      'Codex active turn contains no replayable UserInput items. Use contextMode "fresh".',
    );
  }

  const preceding = activeIndex > 0 ? turns[activeIndex - 1] : null;
  if (preceding && !TERMINAL_TURN_STATUSES.has(preceding.status)) {
    throw new Error(
      'Codex preceding turn is not terminal, so the source cannot be forked safely. Use contextMode "fresh".',
    );
  }
  return {
    currentUserInputs,
    lastTerminalTurnId: preceding?.id ?? null,
  };
}

function cloneUserInput(input: CodexAppServerUserInput): CodexAppServerUserInput {
  if (input.type === 'text') {
    return { ...input, text_elements: [...input.text_elements] };
  }
  return { ...input };
}
