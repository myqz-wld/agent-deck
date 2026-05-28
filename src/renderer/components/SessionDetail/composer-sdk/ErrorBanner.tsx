import type { JSX } from 'react';

/**
 * 通用错误条（5 处复用）：权限模式 / Codex sandbox / Claude OS 沙盒 / 发送 / 图片附件。
 *
 * CHANGELOG_105 拆分：原 ComposerSdk.tsx 内 5 个完全同款 banner JSX (~13 行 each) 抽通用
 * 组件复用，主文件减 ~55 LOC。
 *
 * 行为约束：
 * - `message` falsy 时返回 null（与原行为 `{xxxError && (...)}` 等价）
 * - `prefix` 默认 '⚠'；caller 可传额外前缀文案如「权限模式切换失败」
 * - `onDismiss` 用户点 ✕ 时调；caller 通常 setXxxError(null)
 */
export function ErrorBanner({
  message,
  prefix,
  onDismiss,
}: {
  message: string | null | undefined;
  prefix?: string;
  onDismiss: () => void;
}): JSX.Element | null {
  if (!message) return null;
  return (
    <div className="mb-1.5 flex items-start gap-1.5 rounded border border-status-waiting/40 bg-status-waiting/10 px-2 py-1 text-[10px] text-status-waiting">
      <span className="flex-1">⚠️ {prefix ? `${prefix}：` : ''}{message}</span>
      <button
        type="button"
        onClick={onDismiss}
        className="text-status-waiting/70 hover:text-status-waiting"
        aria-label="关闭"
      >
        ✕
      </button>
    </div>
  );
}
