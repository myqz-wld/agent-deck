import type { AdapterSessionMode } from '@shared/types';

const LABELS: Record<AdapterSessionMode, string> = {
  default: '默认（可执行）',
  plan: '计划模式',
  ask: '问答模式',
};

export function adapterSessionModeOptions(
  modes: readonly AdapterSessionMode[],
): Array<{ value: AdapterSessionMode; label: string }> {
  return modes.map((value) => ({ value, label: LABELS[value] }));
}
