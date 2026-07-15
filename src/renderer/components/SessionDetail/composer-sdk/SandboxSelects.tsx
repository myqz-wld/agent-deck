import { useId, type JSX } from 'react';
import { DeckSelect } from '@renderer/components/DeckSelect';
import {
  CLAUDE_SANDBOX_MODE_OPTIONS,
  CODEX_SANDBOX_MODE_OPTIONS,
  type ClaudeSandboxMode,
  type CodexSandboxMode,
} from '@renderer/lib/sandbox-options';

/**
 * 3 个 sandbox / permission select 行（permissionMode / codex sandbox / claude OS 沙盒）。
 *
 * CHANGELOG_105 拆分：原 ComposerSdk.tsx 内 3 个 select JSX block (~16 行 each) 抽到通用
 * SelectRow + 3 个 options 常量，主文件减 ~50 LOC。
 *
 * 设计：每个 select row 共享同一组 className / disabled state pattern，options 列表与
 * onChange 类型由 caller 决定（用 generic 让 TS 推导出确切的 union value）。change handler
 * 留 caller 提供（依赖 component-local hooks state，不可抽到 module-level）。
 */

/** 通用 select row 组件。Generic T 让 caller 用具体 union type 而非 string。 */
export function SelectRow<T extends string>({
  label,
  value,
  options,
  disabled,
  onChange,
}: {
  label: string;
  value: T;
  options: { value: T; label: string; title?: string }[];
  disabled: boolean;
  onChange: (next: T) => void;
}): JSX.Element {
  const current = options.find((o) => o.value === value);
  // deep-review H3 LOW（a11y，codex）：label htmlFor 关联到 select（旧实现 label 是裸 <span>，
  // select 无 id/aria-label → 可见名称不成为控件程序化名称）。title 是当前选项说明，非字段名。
  const id = useId();
  return (
    <div className="mb-1.5 flex items-center gap-1.5 text-[10px] text-deck-muted">
      <label htmlFor={id}>{label}</label>
      <DeckSelect
        id={id}
        value={value}
        onChange={onChange}
        disabled={disabled}
        title={current?.title}
        options={options}
        className="min-w-0 flex-1"
        buttonClassName="w-full rounded border border-deck-border bg-white/[0.04] px-1.5 py-0.5 text-left text-[10px] outline-none focus:border-white/20 disabled:opacity-50"
      />
    </div>
  );
}

export type PermissionMode = 'default' | 'acceptEdits' | 'plan' | 'bypassPermissions';
export type CodexSandbox = CodexSandboxMode;
export type ClaudeCodeSandbox = ClaudeSandboxMode;

export const PERMISSION_MODE_OPTIONS: { value: PermissionMode; label: string; title?: string }[] = [
  { value: 'default', label: '每次询问', title: '每次工具调用前都询问你是否允许' },
  { value: 'acceptEdits', label: '自动接受文件编辑', title: '自动允许文件编辑；其他工具仍需询问' },
  { value: 'plan', label: '计划模式（只规划）', title: '只生成计划，不执行任何工具调用' },
  { value: 'bypassPermissions', label: '⚠️ 不再询问（仍在系统沙盒内）', title: 'Claude 全程不再询问任何工具调用；系统沙盒（若启用）仍生效' },
];

export const CODEX_SANDBOX_OPTIONS = CODEX_SANDBOX_MODE_OPTIONS;
export const CLAUDE_CODE_SANDBOX_OPTIONS = CLAUDE_SANDBOX_MODE_OPTIONS;
