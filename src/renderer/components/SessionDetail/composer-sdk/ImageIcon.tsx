import type { JSX } from 'react';

/**
 * Inline SVG image icon。原本嵌在 ComposerSdk.tsx 末尾的本地 sub-component；
 * CHANGELOG_105 拆分时抽出独立文件让主文件 LOC 收口。
 *
 * emoji 图标基线对不齐 → 改 inline SVG（详 ComposerSdk 末尾 toolbar 注释）。
 */
export function ImageIcon({ className }: { className?: string }): JSX.Element {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      aria-hidden="true"
    >
      <rect x="3" y="3" width="18" height="18" rx="2" />
      <circle cx="8.5" cy="8.5" r="1.5" />
      <path d="M21 15l-5-5L5 21" />
    </svg>
  );
}
