export const RESOURCES_PLACEHOLDER = '{{AGENT_DECK_RESOURCES}}';

const AGENT_DECK_PLACEHOLDER = /\{\{AGENT_DECK_[A-Z_]*\}\}/g;

/** Return unique unknown Agent Deck placeholder literals in first-seen order. */
export function findUnknownResourcesPlaceholders(text: string): string[] {
  const matches = text.match(AGENT_DECK_PLACEHOLDER);
  if (!matches) return [];
  return [...new Set(matches)].filter((match) => match !== RESOURCES_PLACEHOLDER);
}

/** Replace the canonical resource placeholder with one caller-owned absolute resource root. */
export function substituteResourcesPlaceholderWithRoot(
  text: string,
  resourcesRoot: string,
): string {
  if (!text.includes(RESOURCES_PLACEHOLDER)) return text;
  return text.split(RESOURCES_PLACEHOLDER).join(resourcesRoot);
}
