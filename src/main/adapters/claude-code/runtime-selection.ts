export type ClaudeSandboxMode = 'off' | 'workspace-write' | 'strict';

export function selectClaudeSandboxMode(input: {
  requested?: ClaudeSandboxMode;
  persisted: ClaudeSandboxMode | null;
  readDefault: () => ClaudeSandboxMode | null | undefined;
}): ClaudeSandboxMode {
  return input.requested ?? input.persisted ?? input.readDefault() ?? 'off';
}

export function selectClaudeModel(input: {
  requested?: string;
  persisted: string | null;
  profileDefault?: string;
}): string | undefined {
  return input.requested ?? input.persisted ?? input.profileDefault;
}
