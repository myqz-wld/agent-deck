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
  options: { value: T; label: string; title?: string }[];
  disabled: boolean;
  onChange: (next: T) => void;
}): JSX.Element {
  const current = options.find((o) => o.value === value);
  return (
    <div className="mb-1.5 flex items-center gap-1.5 text-[10px] text-deck-muted">
      <span>{label}</span>
      <select
        value={value}
        onChange={(e) => onChange(e.target.value as T)}
        disabled={disabled}
        title={current?.title}
        className="no-drag flex-1 min-w-0 rounded border border-deck-border bg-white/[0.04] px-1.5 py-0.5 text-[10px] outline-none focus:border-white/20 disabled:opacity-50"
      >
        {options.map((opt) => (
          <option key={opt.value} value={opt.value} title={opt.title}>
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

export const PERMISSION_MODE_OPTIONS: { value: PermissionMode; label: string; title?: string }[] = [
  { value: 'default', label: '每次询问（默认）', title: '每次工具调用前都询问你是否允许' },
  { value: 'acceptEdits', label: '自动接受文件编辑', title: '自动允许文件编辑；其他工具仍需询问' },
  { value: 'plan', label: '计划模式（只规划）', title: '只生成计划，不执行任何工具调用' },
  { value: 'bypassPermissions', label: '⚠️ 不再询问（仍在系统沙盒内）', title: 'Claude 全程不再询问任何工具调用；系统沙盒（若启用）仍生效' },
];

export const CODEX_SANDBOX_OPTIONS: { value: CodexSandbox; label: string; title?: string }[] = [
  { value: 'workspace-write', label: '工作目录可写（默认）', title: '工作目录可写；网络默认禁；其他目录只读' },
  { value: 'read-only', label: '完全只读', title: '所有文件只读，包括工作目录' },
  { value: 'danger-full-access', label: '⚠️ 完全开放（可改任意文件 / 联网 / 运行任意命令）', title: '没有任何限制：可以读写任意文件、访问网络、运行任意命令' },
];

export const CLAUDE_CODE_SANDBOX_OPTIONS: { value: ClaudeCodeSandbox; label: string; title?: string }[] = [
  { value: 'off', label: '⚠️ 关闭（无系统沙盒）', title: '系统不会限制 Claude；仅靠应用内授权弹窗管控' },
  { value: 'workspace-write', label: '工作目录可写', title: '工作目录可写；敏感目录（~/.ssh、~/.aws 等）禁读；网络默认禁' },
  { value: 'strict', label: '严格只读', title: '工作目录也只读，最严格' },
];
