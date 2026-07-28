import type { AdapterSessionMode } from '@shared/types';

const LABELS: Record<AdapterSessionMode, string> = {
  default: '可执行',
  plan: '计划模式',
  ask: '问答模式',
};
const STRICT_TO_PERMISSIVE: readonly AdapterSessionMode[] = ['plan', 'ask', 'default'];

export function adapterSessionModeOptions(
  modes: readonly AdapterSessionMode[],
): Array<{ value: AdapterSessionMode; label: string }> {
  const available = new Set(modes);
  return STRICT_TO_PERMISSIVE
    .filter((value) => available.has(value))
    .map((value) => ({ value, label: LABELS[value] }));
}
