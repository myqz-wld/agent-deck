import {
  isCodexThinkingLevel,
  type CodexThinkingLevel,
} from '@shared/session-metadata';

export interface ResolveCodexReasoningEffortArgs {
  explicit?: CodexThinkingLevel;
  isResume: boolean;
  persisted: unknown;
  hasLayerOverride?: boolean;
  readConfigured: () => CodexThinkingLevel | null;
}

export interface ResolvedCodexReasoningEffort {
  /** Value stored on the Agent Deck session for resume/display. */
  sessionValue?: CodexThinkingLevel;
  /** Explicit ThreadOptions override; omitted for a global-config hint. */
  threadValue?: CodexThinkingLevel;
}

/**
 * Resolve one session's reasoning effort without mutating global Codex configuration.
 *
 * New session: explicit > current top-level config > provider default.
 * Resume: explicit > persisted session value > provider default. A historical null deliberately
 * does not inherit today's global config, which would silently change that existing conversation.
 */
export function resolveCodexReasoningEffort(
  args: ResolveCodexReasoningEffortArgs,
): ResolvedCodexReasoningEffort {
  if (args.explicit !== undefined) {
    return { sessionValue: args.explicit, threadValue: args.explicit };
  }
  if (args.isResume) {
    const persisted = isCodexThinkingLevel(args.persisted) ? args.persisted : undefined;
    return { sessionValue: persisted, threadValue: persisted };
  }
  // A per-session config layer can select a profile or effort unknown to the top-level reader.
  // Keep both fields unset instead of persisting a misleading global hint.
  if (args.hasLayerOverride) return {};
  return { sessionValue: args.readConfigured() ?? undefined };
}
