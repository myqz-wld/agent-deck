import type { JSX } from 'react';

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
  options: { value: T; label: string }[];
  disabled: boolean;
  onChange: (next: T) => void;
}): JSX.Element {
  return (
    <div className="mb-1.5 flex items-center gap-1.5 text-[10px] text-deck-muted">
      <span>{label}</span>
      <select
        value={value}
        onChange={(e) => onChange(e.target.value as T)}
        disabled={disabled}
        className="no-drag flex-1 min-w-0 rounded border border-deck-border bg-white/[0.04] px-1.5 py-0.5 text-[10px] outline-none focus:border-white/20 disabled:opacity-50"
      >
        {options.map((opt) => (
          <option key={opt.value} value={opt.value}>
            {opt.label}
          </option>
        ))}
      </select>
    </div>
  );
}

export type PermissionMode = 'default' | 'acceptEdits' | 'plan' | 'bypassPermissions';
export type CodexSandbox = 'workspace-write' | 'read-only' | 'danger-full-access';
export type ClaudeCodeSandbox = 'off' | 'workspace-write' | 'strict';

export const PERMISSION_MODE_OPTIONS: { value: PermissionMode; label: string }[] = [
  { value: 'default', label: '默认（每次询问）' },
  { value: 'acceptEdits', label: '自动接受编辑' },
  { value: 'plan', label: 'Plan 模式（只规划）' },
  { value: 'bypassPermissions', label: '完全免询问 ⚠️' },
];

export const CODEX_SANDBOX_OPTIONS: { value: CodexSandbox; label: string }[] = [
  { value: 'workspace-write', label: 'workspace-write（默认）' },
  { value: 'read-only', label: 'read-only（只读）' },
  { value: 'danger-full-access', label: 'danger-full-access ⚠️' },
];

export const CLAUDE_CODE_SANDBOX_OPTIONS: { value: ClaudeCodeSandbox; label: string }[] = [
  { value: 'off', label: 'off（不启 OS 沙盒）⚠️' },
  { value: 'workspace-write', label: 'workspace-write' },
  { value: 'strict', label: 'strict（cwd 也只读）' },
];
